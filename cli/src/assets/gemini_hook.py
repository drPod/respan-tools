#!/usr/bin/env python3
"""
Respan Hook for Gemini CLI

Sends Gemini CLI LLM call data to Respan after each model response.
Uses Gemini CLI's AfterModel hook to capture request/response and forward
to Respan's JSON API.

Configuration via environment variables (set in .gemini/.env):
    RESPAN_API_KEY          - Respan API key (required)
    RESPAN_BASE_URL         - Respan API base URL (default: https://api.respan.ai)
    RESPAN_PROJECT_ID       - Respan project ID
    RESPAN_GEMINI_MODEL     - Override model name (default: auto-detect from session)
    CC_RESPAN_DEBUG         - Enable debug logging (set to "true")
    CC_RESPAN_MAX_CHARS     - Max chars for input/output (default: 4000)
"""

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.request import Request, urlopen
from urllib.error import URLError

# Configuration
LOG_FILE = Path.home() / ".gemini" / "state" / "respan_hook.log"
DEBUG = os.environ.get("CC_RESPAN_DEBUG", "").lower() == "true"

try:
    MAX_CHARS = int(os.environ.get("CC_RESPAN_MAX_CHARS", "4000"))
except (ValueError, TypeError):
    MAX_CHARS = 4000


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
    return text[:max_chars] + f"\n... [truncated, {len(text)} total chars]"


def get_config() -> Optional[Dict[str, str]]:
    """Read Respan config from environment."""
    api_key = os.environ.get("RESPAN_API_KEY", "")
    if not api_key:
        # Try reading from .respan profile
        profile_path = Path.home() / ".respan" / "profiles" / "default.json"
        if profile_path.exists():
            try:
                profile = json.loads(profile_path.read_text())
                api_key = profile.get("api_key", "") or profile.get("access_token", "")
            except Exception:
                pass
    if not api_key:
        return None
    return {
        "api_key": api_key,
        "base_url": os.environ.get("RESPAN_BASE_URL", "https://api.respan.ai").rstrip("/"),
        "project_id": os.environ.get("RESPAN_PROJECT_ID", ""),
        "model_override": os.environ.get("RESPAN_GEMINI_MODEL", ""),
    }


def extract_input(hook_data: Dict[str, Any]) -> str:
    """Extract input text from hook data."""
    llm_req = hook_data.get("llm_request", {})
    messages = llm_req.get("messages", [])
    # Get the last user message as input
    for msg in reversed(messages):
        if msg.get("role") == "user":
            return truncate(msg.get("content", ""))
    # Fall back to all messages as JSON
    if messages:
        return truncate(json.dumps(messages, ensure_ascii=False))
    return ""


def extract_output(hook_data: Dict[str, Any]) -> str:
    """Extract output text from hook data."""
    llm_resp = hook_data.get("llm_response", {})
    text = llm_resp.get("text", "")
    if text:
        return truncate(text)
    # Fall back to candidate content
    candidates = llm_resp.get("candidates", [])
    if candidates:
        parts = candidates[0].get("content", {}).get("parts", [])
        if parts:
            return truncate(" ".join(parts))
    return ""


def extract_tokens(hook_data: Dict[str, Any]) -> Dict[str, int]:
    """Extract token usage from hook data."""
    usage = hook_data.get("llm_response", {}).get("usageMetadata", {})
    return {
        "prompt_tokens": usage.get("promptTokenCount", 0) or 0,
        "completion_tokens": usage.get("candidatesTokenCount", 0) or 0,
        "total_tokens": usage.get("totalTokenCount", 0) or 0,
    }


def detect_model(hook_data: Dict[str, Any]) -> str:
    """Detect the model from hook data or environment."""
    # Check environment override
    override = os.environ.get("RESPAN_GEMINI_MODEL", "")
    if override:
        return override
    # Get from llm_request (Gemini CLI includes this)
    llm_req = hook_data.get("llm_request", {})
    model = llm_req.get("model", "")
    if model:
        return model
    return "gemini-cli"


def send_to_respan(config: Dict[str, str], hook_data: Dict[str, Any]) -> None:
    """Send span data to Respan via JSON API."""
    input_text = extract_input(hook_data)
    output_text = extract_output(hook_data)
    tokens = extract_tokens(hook_data)
    model = detect_model(hook_data)
    timestamp = hook_data.get("timestamp", datetime.now(timezone.utc).isoformat())
    session_id = hook_data.get("session_id", "")

    # Build the request/config for metadata
    llm_req = hook_data.get("llm_request", {})
    req_config = llm_req.get("config", {})

    body: Dict[str, Any] = {
        "input": input_text,
        "output": output_text,
        "model": model,
        "log_type": "chat",
        "usage": tokens,
        "status_code": 200,
        "status": "success",
        "timestamp": timestamp,
        "span_name": "llm_call",
        "thread_identifier": session_id,
        "metadata": {
            "source": "gemini-cli",
            "session_id": session_id,
        },
    }

    if req_config.get("temperature") is not None:
        body["temperature"] = req_config["temperature"]
    if req_config.get("maxOutputTokens") is not None:
        body["max_tokens"] = req_config["maxOutputTokens"]
    if config.get("project_id"):
        body["metadata"]["respan.project_id"] = config["project_id"]

    # Build messages for input (full conversation)
    messages = llm_req.get("messages", [])
    if messages:
        formatted = []
        for msg in messages:
            formatted.append({
                "role": msg.get("role", "user"),
                "content": truncate(msg.get("content", "")),
            })
        body["input"] = json.dumps(formatted, ensure_ascii=False)

    url = f"{config['base_url']}/api/request-logs/"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config['api_key']}",
    }

    debug(f"Sending to {url}: model={model}, tokens={tokens}")

    data = json.dumps(body).encode("utf-8")
    req = Request(url, data=data, headers=headers, method="POST")
    try:
        with urlopen(req, timeout=10) as resp:
            debug(f"Response: {resp.status}")
    except URLError as e:
        log("ERROR", f"Failed to send to Respan: {e}")
    except Exception as e:
        log("ERROR", f"Unexpected error: {e}")


def main():
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            debug("Empty stdin, exiting")
            return

        hook_data = json.loads(raw)
        debug(f"Hook event: {hook_data.get('hook_event_name', 'unknown')}")

        config = get_config()
        if not config:
            debug("No Respan API key found, skipping")
            return

        send_to_respan(config, hook_data)

        # Output empty JSON to not interfere with Gemini's processing
        print("{}")

    except json.JSONDecodeError as e:
        log("ERROR", f"Invalid JSON from stdin: {e}")
        print("{}")
    except Exception as e:
        log("ERROR", f"Hook error: {e}")
        print("{}")


if __name__ == "__main__":
    main()
