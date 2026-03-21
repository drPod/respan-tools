#!/usr/bin/env python3
"""
Respan Hook for Gemini CLI

Sends Gemini CLI LLM call data to Respan after each model response.
Uses Gemini CLI's AfterModel hook to capture request/response and forward
to Respan's trace ingest API.

Handles streaming: Gemini fires AfterModel per chunk. We accumulate text
and only send on the final chunk (empty text with completion tokens).

Configuration:
    Auth:    ~/.respan/credentials.json  (from `respan auth login`)
    Config:  ~/.gemini/respan.json       (from `respan integrate gemini-cli`)
    Debug:   GEMINI_RESPAN_DEBUG=true    (check ~/.gemini/state/respan_hook.log)
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
try:
    import requests as _requests
except ImportError:
    _requests = None

# Configuration
STATE_DIR = Path.home() / ".gemini" / "state"
LOG_FILE = STATE_DIR / "respan_hook.log"
DEBUG = os.environ.get("GEMINI_RESPAN_DEBUG", "").lower() == "true"

try:
    MAX_CHARS = int(os.environ.get("GEMINI_RESPAN_MAX_CHARS", "4000"))
except (ValueError, TypeError):
    MAX_CHARS = 4000

# Known config keys in respan.json that map to span fields.
KNOWN_CONFIG_KEYS = {"customer_id", "span_name", "workflow_name", "project_id"}


def log(level: str, message: str) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"{timestamp} [{level}] {message}\n")


def debug(message: str) -> None:
    if DEBUG:
        log("DEBUG", message)


def truncate(text: str, max_chars: int = MAX_CHARS) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n... (truncated)"


# ── Credentials ──────────────────────────────────────────────────

def resolve_credentials() -> Tuple[Optional[str], str]:
    """Resolve API key and base URL from env vars or ~/.respan/credentials.json.

    Matches the credential resolution used by the Claude Code and Codex CLI hooks.
    """
    api_key = os.getenv("RESPAN_API_KEY")
    base_url = os.getenv("RESPAN_BASE_URL", "https://api.respan.ai/api")

    if not api_key:
        creds_file = Path.home() / ".respan" / "credentials.json"
        if creds_file.exists():
            try:
                creds = json.loads(creds_file.read_text(encoding="utf-8"))
                config_file = Path.home() / ".respan" / "config.json"
                profile = "default"
                if config_file.exists():
                    cfg = json.loads(config_file.read_text(encoding="utf-8"))
                    profile = cfg.get("activeProfile", "default")
                cred = creds.get(profile, {})
                api_key = cred.get("apiKey") or cred.get("accessToken")
                if not base_url or base_url == "https://api.respan.ai/api":
                    base_url = cred.get("baseUrl", base_url)
                if api_key:
                    debug(f"Using API key from credentials.json (profile: {profile})")
            except (json.JSONDecodeError, IOError) as e:
                debug(f"Failed to read credentials.json: {e}")

    # Always ensure base_url ends with /api
    if base_url and not base_url.rstrip("/").endswith("/api"):
        base_url = base_url.rstrip("/") + "/api"

    return api_key, base_url


def load_respan_config() -> Dict[str, Any]:
    """Load ~/.gemini/respan.json for span field overrides.

    Returns a dict with two keys:
      - "fields": known span fields (customer_id, span_name, workflow_name, project_id)
      - "properties": everything else (custom properties -> metadata)
    """
    config_path = Path.home() / ".gemini" / "respan.json"
    if not config_path.exists():
        return {"fields": {}, "properties": {}}
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return {"fields": {}, "properties": {}}
        fields = {}
        properties = {}
        for k, v in raw.items():
            if k in KNOWN_CONFIG_KEYS:
                fields[k] = v
            else:
                properties[k] = v
        return {"fields": fields, "properties": properties}
    except (json.JSONDecodeError, IOError) as e:
        debug(f"Failed to load respan.json: {e}")
        return {"fields": {}, "properties": {}}


# ── Streaming accumulator ────────────────────────────────────────

def _state_path(session_id: str) -> Path:
    """Temp file to accumulate streamed text across hook invocations."""
    safe_id = session_id.replace("/", "_").replace("\\", "_")[:64]
    return STATE_DIR / f"respan_stream_{safe_id}.json"


def load_stream_state(session_id: str) -> Dict[str, Any]:
    p = _state_path(session_id)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return {"accumulated_text": "", "last_tokens": 0, "first_chunk_time": ""}


def save_stream_state(session_id: str, state: Dict[str, Any]) -> None:
    p = _state_path(session_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(state))


def clear_stream_state(session_id: str) -> None:
    p = _state_path(session_id)
    try:
        p.unlink(missing_ok=True)
    except Exception:
        pass


# ── Data extraction ───────────────────────────────────────────────

def extract_messages(
    hook_data: Dict[str, Any],
) -> List[Dict[str, str]]:
    """Extract prompt_messages from hook data.

    Preserves all content including Gemini CLI's <session_context> block
    for full trace fidelity.
    """
    llm_req = hook_data.get("llm_request", {})
    messages = llm_req.get("messages", [])
    formatted = []

    # Gemini uses "model" for assistant messages — map to standard roles
    role_map = {"model": "assistant"}

    for msg in messages:
        role = role_map.get(msg.get("role", "user"), msg.get("role", "user"))
        content = msg.get("content", "")
        formatted.append({
            "role": role,
            "content": truncate(content),
        })

    return formatted


def detect_model(hook_data: Dict[str, Any]) -> str:
    """Detect model from hook data or environment."""
    override = os.environ.get("RESPAN_GEMINI_MODEL", "")
    if override:
        return override
    llm_req = hook_data.get("llm_request", {})
    model = llm_req.get("model", "")
    if model:
        return model
    return "gemini-cli"


# ── Span construction ────────────────────────────────────────────

def build_spans(
    hook_data: Dict[str, Any],
    output_text: str,
    tokens: Dict[str, int],
    config: Optional[Dict[str, Any]] = None,
    start_time_iso: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Build a single Respan span for a Gemini CLI LLM call."""
    session_id = hook_data.get("session_id", "")
    model = detect_model(hook_data)
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    end_time = hook_data.get("timestamp") or now_str
    begin_time = start_time_iso or end_time

    # Compute latency from tracked chunk times
    latency: Optional[float] = None
    try:
        t_start = datetime.fromisoformat(begin_time.replace("Z", "+00:00"))
        t_end = datetime.fromisoformat(end_time.replace("Z", "+00:00"))
        latency = max((t_end - t_start).total_seconds(), 0.0)
    except (ValueError, TypeError):
        pass

    # Messages — session context preserved for trace fidelity
    prompt_messages = extract_messages(hook_data)
    completion_message: Dict[str, str] = {"role": "assistant", "content": truncate(output_text)}

    # Config overrides from respan.json
    cfg_fields = (config or {}).get("fields", {})
    cfg_props = (config or {}).get("properties", {})

    # IDs — keep short to avoid DB column truncation
    trace_unique_id = f"gcli_{session_id}"
    span_unique_id = f"gcli_{session_id}_gen"
    workflow_name = os.environ.get("RESPAN_WORKFLOW_NAME") or cfg_fields.get("workflow_name") or "gemini-cli"
    span_name = os.environ.get("RESPAN_SPAN_NAME") or cfg_fields.get("span_name") or "gemini.chat"
    thread_id = f"gcli_{session_id}"
    customer_id = os.environ.get("RESPAN_CUSTOMER_ID") or cfg_fields.get("customer_id") or ""

    # LLM config
    llm_req = hook_data.get("llm_request", {})
    req_config = llm_req.get("config", {})

    # Metadata — custom properties from respan.json, then env overrides
    metadata: Dict[str, Any] = {"source": "gemini-cli"}
    if cfg_props:
        metadata.update(cfg_props)
    env_metadata = os.environ.get("RESPAN_METADATA")
    if env_metadata:
        try:
            extra = json.loads(env_metadata)
            if isinstance(extra, dict):
                metadata.update(extra)
        except json.JSONDecodeError:
            pass

    # Token counts
    prompt_tokens = tokens.get("prompt_tokens", 0)
    completion_tokens = tokens.get("completion_tokens", 0)
    total_tokens = tokens.get("total_tokens", 0) or (prompt_tokens + completion_tokens)

    span: Dict[str, Any] = {
        "trace_unique_id": trace_unique_id,
        "span_unique_id": span_unique_id,
        "span_name": span_name,
        "span_workflow_name": workflow_name,
        "thread_identifier": thread_id,
        "customer_identifier": customer_id,
        "model": model,
        "log_type": "chat",
        "provider_id": "google",
        "input": json.dumps(prompt_messages) if prompt_messages else "",
        "output": json.dumps(completion_message),
        "prompt_messages": prompt_messages,
        "completion_message": completion_message,
        "timestamp": end_time,
        "start_time": begin_time,
        "metadata": metadata,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
    }

    if latency is not None:
        span["latency"] = latency

    # Optional LLM config fields
    if req_config.get("temperature") is not None:
        span["temperature"] = req_config["temperature"]
    if req_config.get("maxOutputTokens") is not None:
        span["max_tokens"] = req_config["maxOutputTokens"]

    # Platform defaults (must match Claude Code / Codex hooks exactly)
    respan_defaults = {
        "warnings": "",
        "encoding_format": "float",
        "disable_fallback": False,
        "respan_params": {
            "has_webhook": False,
            "environment": os.environ.get("RESPAN_ENVIRONMENT", "prod"),
        },
        "field_name": "data: ",
        "delimiter": "\n\n",
        "disable_log": False,
        "request_breakdown": False,
    }
    for key, value in respan_defaults.items():
        if key not in span:
            span[key] = value

    return [span]


# ── Send to Respan ────────────────────────────────────────────────

def send_spans(
    spans: List[Dict[str, Any]],
    api_key: str,
    base_url: str,
) -> None:
    """Send spans to Respan as a single batch via /v1/traces/ingest (array format).

    Uses subprocess curl to avoid a hard dependency on the ``requests`` library.
    """
    url = f"{base_url}/v1/traces/ingest"

    span_names = [s.get("span_name", "?") for s in spans]
    debug(f"Sending {len(spans)} span(s) to {url}: {span_names}")

    if DEBUG:
        debug_file = STATE_DIR / "respan_last_payload.json"
        debug_file.write_text(json.dumps(spans, indent=2), encoding="utf-8")

    # Write payload to temp file and launch a fully independent sender process.
    # This avoids Gemini CLI killing the HTTP request mid-flight.
    import subprocess
    payload_file = STATE_DIR / f"respan_send_{os.getpid()}.json"
    payload_file.write_text(json.dumps(spans), encoding="utf-8")

    sender = Path.home() / ".respan" / "send_spans.py"
    try:
        subprocess.Popen(
            ["python3", str(sender), str(payload_file), api_key, url],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        debug("Launched sender subprocess")
    except Exception as e:
        log("ERROR", f"Failed to launch sender: {e}")
        payload_file.unlink(missing_ok=True)


def main():
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            print("{}")
            return

        hook_data = json.loads(raw)
        session_id = hook_data.get("session_id", "unknown")

        # Extract current chunk data
        llm_resp = hook_data.get("llm_response", {})
        chunk_text = llm_resp.get("text", "") or ""
        usage = llm_resp.get("usageMetadata", {})
        completion_tokens = usage.get("candidatesTokenCount", 0) or 0

        # Check for finish signal in candidates
        candidates = llm_resp.get("candidates", [])
        finish_reason = ""
        if candidates and isinstance(candidates, list):
            finish_reason = candidates[0].get("finishReason", "") if isinstance(candidates[0], dict) else ""

        # Load accumulated state
        state = load_stream_state(session_id)

        is_finished = finish_reason in ("STOP", "MAX_TOKENS", "SAFETY")

        # Step 1: accumulate text chunks
        if chunk_text:
            if not state.get("first_chunk_time"):
                state["first_chunk_time"] = datetime.now(timezone.utc).strftime(
                    "%Y-%m-%dT%H:%M:%S.%f"
                )[:-3] + "Z"
            state["accumulated_text"] += chunk_text
            state["last_tokens"] = completion_tokens or state.get("last_tokens", 0)
            save_stream_state(session_id, state)
            debug(f"Accumulated chunk: +{len(chunk_text)} chars, total={len(state['accumulated_text'])}")

        # Step 2: detect completion and send.
        # Final signal is one of:
        #   a) Empty text chunk after we've accumulated text (most models)
        #   b) finishReason set on the last text chunk (gemini-2.5-flash)
        should_send = state["accumulated_text"] and (
            (not chunk_text) or is_finished
        )

        # Print response immediately so Gemini CLI can proceed
        print("{}")
        sys.stdout.flush()

        if should_send:
            debug(f"Final chunk (finish_reason={finish_reason}), "
                  f"sending {len(state['accumulated_text'])} chars")

            api_key, base_url = resolve_credentials()
            if api_key:
                final_prompt = usage.get("promptTokenCount", 0) or 0
                final_completion = completion_tokens or state.get("last_tokens", 0)
                final_total = usage.get("totalTokenCount", 0) or 0
                tokens = {
                    "prompt_tokens": final_prompt,
                    "completion_tokens": final_completion,
                    "total_tokens": final_total or (final_prompt + final_completion),
                }
                config = load_respan_config()
                spans = build_spans(
                    hook_data,
                    state["accumulated_text"],
                    tokens,
                    config,
                    start_time_iso=state.get("first_chunk_time"),
                )
                send_spans(spans, api_key, base_url)
            else:
                log("ERROR", "No API key found. Run: respan auth login")

            clear_stream_state(session_id)

    except json.JSONDecodeError as e:
        log("ERROR", f"Invalid JSON from stdin: {e}")
        print("{}")
    except Exception as e:
        log("ERROR", f"Hook error: {e}")
        print("{}")


if __name__ == "__main__":
    main()
