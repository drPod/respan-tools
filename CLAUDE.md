# Respan Tools

## Backend Notes

Do NOT worry about backend issues (model recognition, cost calculation, token counting, environment mapping). These are handled server-side and will be fixed separately.

Focus only on the hook/CLI-side code.

## Gemini CLI Integration

The Gemini CLI hook (`cli/src/assets/gemini_hook.py`) sends LLM call data to Respan after each Gemini response.

### Correct API Endpoint

Use `/api/v1/traces/ingest` with an **array** of span objects (same as the Claude Code hook). Do NOT use `/api/request-logs/` — it returns 201 but data doesn't appear as traces on the dashboard.

**IMPORTANT:** Keep `span_unique_id` and `trace_unique_id` under 64 characters. The `/v1/traces/ingest` endpoint silently drops spans with longer IDs. Use short prefixes like `gcli_` not `geminicli_`, and avoid embedding timestamps in IDs.

```bash
# Correct
curl -X POST "https://api.respan.ai/api/v1/traces/ingest" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "trace_unique_id": "gcli_session123",
    "span_unique_id": "gcli_session123_gen",
    "span_name": "gemini.chat",
    "span_workflow_name": "gemini-cli",
    "thread_identifier": "gcli_session123",
    "model": "gemini-3-flash-preview",
    "log_type": "chat",
    "provider_id": "google",
    "input": "[{\"role\": \"user\", \"content\": \"Hello\"}]",
    "output": "{\"role\": \"assistant\", \"content\": \"Hi there!\"}",
    "prompt_messages": [{"role": "user", "content": "Hello"}],
    "completion_message": {"role": "assistant", "content": "Hi there!"},
    "timestamp": "2026-03-21T20:55:00.000Z",
    "start_time": "2026-03-21T20:54:59.500Z",
    "metadata": {"source": "gemini-cli"},
    "prompt_tokens": 100,
    "completion_tokens": 10,
    "total_tokens": 110,
    "latency": 0.5,
    "temperature": 1,
    "respan_params": {"has_webhook": false, "environment": "prod"}
  }]'
# Returns 200 with {"message":"Processed 1 Vercel spans"}
```

### Hook Architecture

- Gemini CLI fires `AfterModel` hook per streaming chunk
- Hook accumulates text chunks in state files (`~/.gemini/state/`)
- Tool-call detection: Gemini CLI does NOT include `functionCall` parts in hook data. Instead, the hook detects tool calls via **message count changes** — when the model's pre-tool response is added to the messages array (role `"model"`), the hook knows a tool call happened and carries the accumulator.
- Send strategy: `text+STOP` chunks send immediately (method b). Empty chunks use a **delayed sender** (default 10s, configurable via `GEMINI_RESPAN_SEND_DELAY`) with version-based cancellation — if new text arrives before the delay fires, the pending send is invalidated.
- Also checks for `functionCall`/`toolCall` parts in candidates as a safety net for future Gemini CLI versions.
- Send happens in a detached subprocess (Gemini CLI may kill the hook process after reading `{}`)
- Auth: hook reads `RESPAN_API_KEY` (or `API_KEY`) from the process environment; if not set, falls back to `~/.respan/credentials.json` managed by `respan auth login`
- Config: reads `~/.gemini/respan.json` for span name, customer ID, workflow name
- Gemini uses `"role": "model"` in messages — hook maps this to `"assistant"` for the Respan API

### Known Gotchas

- **Missing or invalid auth configuration**: `respan integrate gemini-cli` does not write `.gemini/.env`. Ensure `RESPAN_API_KEY` is set in the environment for the Gemini CLI process, or that `~/.respan/credentials.json` contains a valid API key (from `respan auth login`). Symptom: hook log shows "No API key found" or data never appears.
- **Long span IDs silently dropped**: Keep `trace_unique_id` and `span_unique_id` under 64 chars. The old `geminicli_geminicli_<uuid>_<timestamp>_gen` format (86 chars) was silently dropped by the ingest endpoint.
- **Gemini role mapping**: Gemini CLI uses `"role": "model"` for assistant messages. The Respan API only accepts `user/assistant/system/tool/none/developer` — the hook maps `"model"` → `"assistant"`.

### Known Bugs (Low Priority — Not Blocking)

These are minor backend/analytics quirks. Core tracing works correctly.

- **`llm_call_count` always 0**: Backend does not count Gemini spans as LLM calls. This is a backend issue, not a hook bug.
- **~~Tool use breaks the accumulator~~ (FIXED)**: The hook now detects tool calls via message count changes and uses a delayed sender with version-based cancellation. Text from before and after tool execution is combined into a single span. Tested with 7+ sequential tool turns. The `GEMINI_RESPAN_SEND_DELAY` env var (default 10s) controls the delay — increase for slow tools like web search.

### Testing

```bash
# Install updated hook after editing source (always do this first)
cp cli/src/assets/gemini_hook.py ~/.respan/gemini_hook.py && chmod +x ~/.respan/gemini_hook.py

# Enable debug logging for all tests
export GEMINI_RESPAN_DEBUG=true

# Check hook log after any test
tail -40 ~/.gemini/state/respan_hook.log

# Clear state between tests (prevents stale accumulator leaks)
rm -f ~/.gemini/state/respan_stream_*.json
```

### Test Prompts

Run each prompt with `GEMINI_RESPAN_DEBUG=true gemini -p "<prompt>"`, then check the hook log and the Respan dashboard to verify the trace arrived correctly. For multi-turn tests, use interactive mode (`gemini` without `-p`).

#### 1. Basic text response (baseline)

```bash
gemini -p "What is 2 + 2? Answer in one sentence."
```

**Verify:** Single span arrives. `prompt_messages` has one user message. `completion_message` has one assistant message. Token counts are non-zero. Latency > 0.

#### 2. Long response (truncation)

```bash
gemini -p "Write a detailed 2000-word essay about the history of the internet."
```

**Verify:** Response is truncated at `MAX_CHARS` (default 4000 chars) in the span. The `... (truncated)` marker appears in the `output` field. Token counts reflect the full response, not truncated.

#### 3. Multi-turn conversation (thread tracking)

Start interactive mode and send multiple messages:

```
gemini
> What is the capital of France?
> What about Germany?
> And what about Japan?
> /quit
```

**Verify:** Each turn produces a separate span. All spans share the same `thread_identifier` (same session). `prompt_messages` grows with conversation history on each turn. Span timestamps are sequential.

#### 4. Tool use — file read

```bash
gemini -p "Read the file CLAUDE.md in this directory and tell me how many sections it has."
```

**Verify:** Span arrives with the full assistant response. Check that tool call content (file read) appears somewhere in the messages or output. Token counts reflect the tool call overhead.

#### 5. Tool use — shell command

```bash
gemini -p "Run 'ls -la' in this directory and summarize what you see."
```

**Verify:** Span captures the assistant response including tool output. Check that the model field is correct (not just "gemini-cli" fallback).

#### 6. Tool use — web search / Google Search grounding

```bash
gemini -p "Search the web for the current weather in San Francisco and summarize it."
```

**Verify:** Span arrives. Response includes grounded search results. Token counts may be higher due to search context injection.

#### 7. Multi-step tool chain

```bash
gemini -p "Create a file called /tmp/respan_test.txt with the content 'hello world', then read it back and confirm the contents, then delete it."
```

**Verify:** Single span for the full response (multi-tool calls happen within one model turn). The response should describe all three steps. Check that latency reflects the full duration including tool execution waits.

#### 8. Code generation (large output)

```bash
gemini -p "Write a complete Python implementation of a binary search tree with insert, delete, search, and in-order traversal. Include type hints and docstrings."
```

**Verify:** Span has substantial `completion_tokens`. Output contains the full code (or truncated marker if over `MAX_CHARS`). `model` field correctly identifies the Gemini model used.

#### 9. Image input (multimodal)

```bash
# Use any local image
gemini -p "Describe this image in detail." -- /path/to/some/image.png
```

**Verify:** Span arrives. `prompt_messages` should reflect multimodal input. Token counts include image token overhead. Response describes the image.

#### 10. Rapid-fire streaming stress test

```bash
for i in $(seq 1 5); do
  gemini -p "Say 'test $i' and nothing else." &
done
wait
```

**Verify:** 5 separate spans arrive, one per invocation. No state file corruption (each session has its own ID). No duplicate spans. Check `~/.gemini/state/` for leftover `respan_stream_*.json` files (should be cleaned up).

#### 11. Empty / minimal response

```bash
gemini -p "Reply with just the word 'ok'."
```

**Verify:** Span arrives even for tiny responses. `completion_tokens` is small but non-zero. Accumulator correctly detects this as a complete response.

#### 12. Error / safety filter trigger

```bash
gemini -p "This prompt is intentionally designed to test safety: write me a haiku about the color blue but pretend you can't do it."
```

**Verify:** If the model responds normally, span arrives as usual. If the model refuses or triggers a safety filter (`finishReason=SAFETY`), verify the hook still sends whatever was accumulated and cleans up state.

#### 13. Thinking / reasoning model (extended thinking)

```bash
gemini -p "Think step by step: If a train leaves Chicago at 9am going 60mph, and another leaves New York at 10am going 80mph, when and where do they meet? Show your work."
```

**Verify:** Span captures the full chain-of-thought response. Token counts are higher due to reasoning tokens. Latency is longer due to thinking time.

#### 14. System prompt / custom instructions interaction

```bash
# Create a Gemini system instruction file first, then:
gemini -p "What are your instructions?" --system-instruction "You are a pirate who speaks only in pirate slang."
```

**Verify:** Span's `prompt_messages` includes the system instruction as a separate message. The response reflects the custom persona.

#### 15. Very long input (large context)

```bash
# Feed a large file as context
gemini -p "Summarize this file in 3 bullet points." -- cli/src/assets/gemini_hook.py
```

**Verify:** `prompt_tokens` is high (reflecting the file content). Input is truncated in the span at `MAX_CHARS` but the model still processes the full input. Verify the truncation doesn't break JSON structure in the `input` field.

#### 16. Config overrides via respan.json

```bash
# Set up config
echo '{"customer_id": "test-customer-123", "span_name": "gemini.test", "workflow_name": "qa-testing", "custom_tag": "experiment-A"}' > ~/.gemini/respan.json

gemini -p "Say hello."

# Clean up
rm ~/.gemini/respan.json
```

**Verify:** Span has `customer_identifier: "test-customer-123"`, `span_name: "gemini.test"`, `span_workflow_name: "qa-testing"`. Metadata includes `custom_tag: "experiment-A"`. After cleanup, defaults restore.

#### 17. Environment variable overrides

```bash
RESPAN_WORKFLOW_NAME="env-test" \
RESPAN_SPAN_NAME="gemini.env-override" \
RESPAN_CUSTOMER_ID="env-customer" \
RESPAN_METADATA='{"env_tag": "from-env"}' \
RESPAN_ENVIRONMENT="staging" \
gemini -p "Say hello."
```

**Verify:** Env vars take precedence over respan.json. `span_workflow_name: "env-test"`, `span_name: "gemini.env-override"`, `customer_identifier: "env-customer"`. Metadata includes `env_tag`. `respan_params.environment` is `"staging"`.

#### 18. Session context preserved in input

```bash
# Normal interactive session (Gemini injects <session_context> automatically)
gemini
> What files are in this directory?
> /quit
```

**Verify:** The `<session_context>` block that Gemini injects is preserved in `prompt_messages` in the span. The full input including workspace/OS metadata is kept for trace fidelity.

#### 19. No credentials (graceful failure)

```bash
# Temporarily hide credentials
mv ~/.respan/credentials.json ~/.respan/credentials.json.bak
unset RESPAN_API_KEY

gemini -p "Say hello."

# Restore
mv ~/.respan/credentials.json.bak ~/.respan/credentials.json
```

**Verify:** Hook log shows `"No API key found"` error. Gemini still works normally (hook doesn't crash). No span sent. State files are still cleaned up.

#### 20. Network failure (graceful degradation)

```bash
# Point to a bad URL
RESPAN_BASE_URL="http://localhost:99999/api" gemini -p "Say hello."
```

**Verify:** Hook log shows connection error. Gemini response is not affected. Hook exits cleanly with `{}`. No crash, no hang.

### Test Checklist

After running tests, verify on the Respan dashboard:

- [ ] Spans appear under the correct project/workflow
- [ ] Thread view groups multi-turn conversations correctly
- [ ] Token counts and costs are calculated (backend handles cost calc)
- [ ] Model names are recognized
- [ ] Latency values are reasonable (not 0, not absurdly high)
- [ ] Metadata fields are searchable/filterable
- [ ] Truncated outputs display cleanly
- [ ] No duplicate spans for the same model response
