# Roadmap

## Phase 1: Backend — Clean up OpenAPI spec

- Audit and update `openapi.yml` to accurately reflect all current endpoints
- Update request/response schemas to match actual API behavior
- Separate internal endpoints from public API endpoints
- Version the public API surface (e.g. `/v1/`)
- Ensure all public endpoints have proper descriptions, examples, and error responses documented

## Phase 2: Fern — Set up SDK generation

- Set up Fern in the repo (`fern init`)
- Point Fern at the cleaned-up OpenAPI spec
- Configure Fern generators for TypeScript SDK
- Configure auth (Bearer token / API key) in the Fern definition
- Configure pagination patterns
- Test generated SDK against the live API
- Publish `@respan/sdk` to npm

## Phase 3: CLI — Migrate to generated SDK

- Replace `@respan/shared` with `@respan/sdk` in the CLI
- Remove hand-written endpoint functions and types
- Update CLI commands to use the generated SDK client
- Verify all commands still work end-to-end
- Remove `packages/shared` from the monorepo

## Phase 4: MCP Server — Build using the SDK

- Create `@respan/mcp` package
- Use `@respan/sdk` for all API calls
- Expose Respan resources and tools via MCP protocol
- Test with Claude Desktop / Claude Code
- Publish to npm

## Phase 5: Ongoing

- Any backend API change -> update OpenAPI spec -> Fern regenerates SDK -> CLI and MCP stay in sync automatically
