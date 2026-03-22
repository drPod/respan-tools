# MCP Implementation Debug Log

## Iteration 1 — Core Architecture + Bug Fixes
- Added `respanRequest()` + `validatePathParam()` for SDK gaps
- Changed all tools to `(server, deps: ToolDeps)` pattern
- Fixed `get_prompt_detail` and `get_prompt_version_detail` (direct HTTP)
- Fixed unused params in `list_prompts`, `list_evaluators`, `list_datasets`
- Fixed `create_experiment` (direct HTTP, correct v2 endpoint)
- Added `validatePathParam()` to all ID-accepting tools
- **43/43 PASS**

## Iteration 2 — Deeper Testing + Cleanup
- Moved `ToolDeps` from `index.ts` to `client.ts` (no circular deps)
- Fixed `create_prompt_version` message double-serialization
- Verified Zod 3.25.76 compatibility, Zod validation, stdio mode
- **45 additional tests PASS**

## Iteration 3 — Regression + Security
- Added `validatePathParam` to `get_customer_detail`
- Verified SDK internals match reference behavior
- Tested concurrent tool calls
- **41/41 PASS**

## Iteration 4 — Page Object Bug + Production Comparison
- **Fixed `list_logs` and `list_customers` Page object serialization** — was serializing SDK `Page` wrapper (including raw HTTP response), now extracts `page.response` for clean `{count, next, results}` output
- **Compared all 11 shared tool schemas against production MCP server** (`https://mcp.respan.ai/mcp`)
- Fixed `create_log` — restored `keywordsai_api_controls` param (production still has it)
- Fixed `list_prompts` — restored `page_size` param (production has it)
- **All 11 shared tools now match production exactly**
- **42/42 PASS**

## Cumulative

### Total Tests: 180+, All Passing

### Critical Bugs Fixed: 8
1. `get_prompt_detail` — SDK has no single-prompt method → direct HTTP
2. `get_prompt_version_detail` — SDK has no single-version method → direct HTTP
3. `create_experiment` — wrong endpoint + SDK type gaps → direct HTTP to `/api/v2/experiments/`
4. `create_prompt_version` — messages double-serialization (JSON.stringify per message)
5. `list_logs` — Page object serialization (would return massive garbled response)
6. `list_customers` — Page object serialization (same issue)
7. Unused params declared but ignored (`list_prompts`, `list_evaluators`, `list_datasets`)
8. Missing `validatePathParam` on multiple tools (security)

### Production Schema Comparison ✓
All 11 shared tools (list_logs, get_log_detail, create_log, list_traces, get_trace_tree, list_customers, get_customer_detail, list_prompts, get_prompt_detail, list_prompt_versions, get_prompt_version_detail) have identical parameter schemas to the production MCP server.

### Files Changed
| File | Key Changes |
|------|------------|
| `lib/shared/client.ts` | `ToolDeps`, `validatePathParam`, `respanRequest` |
| `lib/index.ts` | Uses `ToolDeps` from client |
| `lib/shared/mcp-handler.ts` | Passes `auth` + `client` as deps |
| `lib/observe/logs.ts` | Page response extraction, `validatePathParam`, restored `keywordsai_api_controls` |
| `lib/observe/traces.ts` | `validatePathParam` |
| `lib/observe/users.ts` | Page response extraction, `validatePathParam` on customer_identifier |
| `lib/develop/prompts.ts` | Direct HTTP for single-resource, fixed messages, restored `page_size` |
| `lib/develop/experiments.ts` | Direct HTTP for create, correct v2 endpoint, `validatePathParam` |
| `lib/evaluate/evaluators.ts` | Removed unused params, `validatePathParam` |
| `lib/evaluate/datasets.ts` | Removed unused params, `validatePathParam` |
| `_local_server.mjs` | Passes deps object |
