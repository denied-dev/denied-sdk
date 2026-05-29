# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a monorepo containing SDK implementations for the Denied authorization platform in multiple languages, plus platform extensions:

- **Python SDK** (`/python`): Python 3.10+ client using httpx and Pydantic
- **TypeScript SDK** (`/typescript`): TypeScript/JavaScript client using axios
- **OpenClaw extension** (`/extensions/openclaw`): OpenClaw plugin that enforces authorization on every tool call
- **Claude Code extension** (`/extensions/claude-code`): Claude Code hook plugin that enforces authorization on every tool call

Both SDKs provide identical functionality for interacting with a Denied authorization server following the Authzen Authorization API 1.0 specification to check permissions for subjects performing actions on resources.

## Commands

### Python SDK (`/python`)

The Python SDK uses `uv` for dependency management:

```bash
# Install dependencies (dev dependencies are included by default)
cd python
uv sync

# Install with ADK integration
uv sync --extra adk

# Lint (check only)
ruff check .

# Lint (with auto-fix)
ruff check --fix .

# Format check
ruff format --check .

# Format (apply)
ruff format .

# Run all tests
uv run pytest

# Run specific test file
uv run pytest tests/test_client.py

# Run specific test function
uv run pytest tests/test_client.py::test_function_name

# Build package
python -m build

# Run example
python examples/example_usage.py
```

### TypeScript SDK (`/typescript`)

The TypeScript SDK uses `pnpm`:

```bash
# Install dependencies
pnpm install

# Build (compile TypeScript to JavaScript)
pnpm run --filter sdk build

# Lint (check only)
pnpm run --filter sdk lint

# Lint (with auto-fix)
pnpm run --filter sdk lint:fix

# Format check
pnpm run --filter sdk format:check

# Format (apply)
pnpm run --filter sdk format

# Run all tests
pnpm run --filter sdk test

# Run tests in watch mode
pnpm run --filter sdk test:watch

# Run example
node examples/example-usage.ts  # After building
```

### OpenClaw Extension (`/extensions/openclaw`)

The OpenClaw extension uses `pnpm`. Registry installs require compiled JavaScript, so the package ships a `tsc` build to `dist/`:

```bash
# Install dependencies
pnpm install

# Build (compile TypeScript to dist/) — required before publishing or registry install
pnpm run --filter @denied-dev/denied-openclaw-plugin build

# Link for development (loads ./index.ts source directly, no build needed)
openclaw plugins install -l ./extensions/openclaw
```

### Pre-commit Hooks

This repository uses pre-commit hooks for both Python and TypeScript:

```bash
# Install pre-commit (if not already installed)
pip install pre-commit

# Install the git hooks
pre-commit install

# Run manually on all files
pre-commit run --all-files
```

## Architecture

### Core Concepts

Both SDKs implement the Authzen Authorization API 1.0 specification:

1. **Entities**: Subjects (users, services) and Resources (documents, APIs) identified by `type` and `id`
2. **Checks**: Authorization requests that ask "Can this subject perform this action on this resource?"
3. **Responses**: Boolean `decision` with optional nested `context` containing `reason` and `rules`

### Client Design

**Python** (`python/src/denied_sdk/client.py`):

- `DeniedClient` class with context manager support (`__enter__`/`__exit__`)
- Must call `close()` or use as context manager to clean up httpx connection pool
- Uses Pydantic models for validation
- API key passed via `X-API-Key` header
- Check endpoints: `/pdp/check` and `/pdp/check/bulk`

**TypeScript** (`typescript/src/client.ts`):

- `DeniedClient` class with axios instance
- API key passed via `X-API-Key` header
- Check endpoints: `/pdp/check` and `/pdp/check/bulk`
- Promise-based async API

### Configuration

Both SDKs support configuration via:

1. Constructor parameters (takes precedence)
2. Environment variables:
   - `DENIED_URL`: Server URL (default: `https://api.denied.dev`)
   - `DENIED_API_KEY`: API key for authentication

### Schema Architecture

The schema implementations follow the Authzen Authorization API 1.0 specification:

**Python** (`python/src/denied_sdk/schemas/check.py`):

- Pydantic models with runtime validation
- `SubjectOrResourceBase` with mandatory `type`, `id`, and optional `properties` fields
- `Subject` and `Resource` extend `SubjectOrResourceBase`
- `Action` object with `name` and optional `properties`
- `CheckRequest` bundles subject, action, resource, and optional context
- `CheckRequest` uses `@field_validator` to coerce `SubjectLike`/`ActionLike`/`ResourceLike` union inputs to typed objects automatically
- `CheckResponse` contains `decision` boolean and optional nested `context` with `reason` and `rules`
- `SubjectLike = Subject | dict | str`, `ResourceLike = Resource | dict | str`, `ActionLike = Action | dict | str`

**TypeScript** (`typescript/src/schemas.ts`):

- TypeScript interfaces (compile-time types only)
- `SubjectOrResource` base interface with mandatory `type`, `id`, and optional `properties`
- `Subject` and `Resource` extend `SubjectOrResource`
- `Action` interface with `name` and optional `properties`
- `CheckRequest` and `CheckResponse` mirror Python structure with full Authzen compatibility
- `SubjectLike = Subject | string`, `ResourceLike = Resource | string`, `ActionLike = Action | string`

### Entity Structure

Following Authzen specification, all entities require:

- **`type`** (required): String identifier for the entity type (e.g., "user", "document", "api")
- **`id`** (required): Unique identifier scoped to the type (e.g., "alice", "doc-123")
- **`properties`** (optional): Additional properties as key-value pairs

### API Methods

Both clients expose two methods following Authzen specification:

1. **`check()`**: Single authorization check
   - Sends POST to `/pdp/check` endpoint
   - Signature (Python): `check(subject, action, resource, context=None)`
   - Signature (TypeScript): `check({ subject, action, resource, context? })`
   - **`subject`** and **`resource`**: Accept a typed object, a dict (Python only), or a `"type://id"` URI string
   - **`action`**: Accepts a typed object, a dict (Python only), or a plain string action name
   - All three are **required**; `context` is optional
   - Returns `CheckResponse` with `decision` and optional `context`

2. **`bulk_check()`/`bulkCheck()`**: Multiple checks in one request
   - Sends POST to `/pdp/check/bulk` endpoint
   - Accepts array of `CheckRequest` objects (each with Subject, Action, and Resource)
   - Returns array of `CheckResponse` objects

**Example (Python)**:

```python
# URI string shorthand
response = client.check(
    subject="user://alice",
    action="read",
    resource="document://123",
)

# Typed objects with properties
response = client.check(
    subject=Subject(type="user", id="alice", properties={"role": "admin"}),
    action=Action(name="read"),
    resource=Resource(type="document", id="123"),
    context={"ip": "192.168.1.1"},
)
print(response.decision)  # True or False
print(response.context.reason)  # Optional reason
```

**Example (TypeScript)**:

```typescript
// URI string shorthand
const response = await client.check({
  subject: "user://alice",
  action: "read",
  resource: "document://123",
});

// Typed objects with properties
const response = await client.check({
  subject: { type: "user", id: "alice", properties: { role: "admin" } },
  action: { name: "read" },
  resource: { type: "document", id: "123" },
  context: { ip: "192.168.1.1" },
});
console.log(response.decision); // true or false
console.log(response.context?.reason); // Optional reason
```

### Key Implementation Details

**Python-specific**:

- Resource cleanup is critical: use context manager pattern or manually call `close()`
- Error handling wraps `httpx.HTTPStatusError` with response body in message
- Uses `model_dump()` to serialize Pydantic models to JSON
- Uses `model_validate()` to deserialize JSON to Pydantic models
- Headers built dynamically to include optional API key
- `CheckRequest` uses `@field_validator` with `mode="before"` to coerce `SubjectLike`, `ActionLike`, and `ResourceLike` inputs before Pydantic validation
- Invalid `"type://id"` strings raise `ValueError` (wrapped in Pydantic `ValidationError`)

**TypeScript-specific**:

- Axios error handling wraps errors with HTTP status and response data
- `DeniedClient` has private static `coerceSubject`, `coerceResource`, `coerceAction` methods for input coercion
- Invalid `"type://id"` strings throw `Error` synchronously before the HTTP call
- Exports both types and runtime values from `index.ts`
- CommonJS module format (`type: "commonjs"` in package.json)
- Builds to `./dist` directory with type declarations
- Headers built dynamically to include optional API key

## Project Structure

```
denied-sdk/
├── python/
│   ├── src/denied_sdk/
│   │   ├── __init__.py          # Public API exports
│   │   ├── client.py            # DeniedClient, AsyncDeniedClient
│   │   └── schemas/
│   │       └── check.py         # Authzen-compliant Pydantic models
│   ├── examples/
│   │   └── example_usage.py
│   └── pyproject.toml           # Python package config
│
├── typescript/
│   ├── src/
│   │   ├── index.ts             # Public API exports
│   │   ├── client.ts            # DeniedClient implementation
│   │   └── schemas.ts           # Authzen-compliant TypeScript interfaces
│   ├── examples/
│   │   └── example-usage.ts
│   ├── package.json             # NPM package config
│   └── tsconfig.json            # TypeScript compiler config
│
└── extensions/
    ├── claude-code/
    │   ├── .claude-plugin/
    │   │   └── plugin.json       # Plugin manifest (name, version)
    │   ├── hooks/
    │   │   ├── hooks.json        # PreToolUse hook registration
    │   │   └── interceptor.js    # Authorization interceptor (zero deps)
    │   └── README.md             # Plugin documentation
    │
    └── openclaw/
        ├── src/
        │   ├── handler.ts       # before_tool_call hook implementation
        │   └── types.ts         # OpenClaw hook types + PluginConfig
        ├── index.ts             # Plugin entrypoint (register function)
        ├── tsconfig.json        # tsc build config (ESM output to dist/)
        ├── openclaw.plugin.json # Plugin manifest (id, configSchema, uiHints)
        └── package.json         # Package config (extensions + runtimeExtensions entries)
```

## Development Workflow

### Adding New Features

When adding new features to either SDK:

1. Update schemas first (Pydantic models in Python, interfaces in TypeScript)
2. Add methods to the respective `DeniedClient` class
3. Export new types/classes from the main `__init__.py` or `index.ts`
4. Update examples if adding user-facing functionality
5. Maintain API parity between both SDKs

### OpenClaw Extension Design

The plugin (`extensions/openclaw`) registers a `before_tool_call` hook via `api.on(...)` at priority `1000`. For each tool call:

1. It reads `api.pluginConfig` (typed as `DeniedPluginConfig`) at registration time to instantiate `DeniedClient` once
2. The hook sends a Denied check with subject `openclaw/<agentId>`, action `execute`, and resource `tool/<toolName>`
3. If the decision is `false`, the tool call is blocked with the reason from the Denied response
4. If the Denied server is unreachable, the hook logs the error and then follows the `failMode` setting: `open` (default) allows the call, `closed` denies it

Config is declared in `openclaw.plugin.json` (`configSchema` + `uiHints`) and read in `index.ts` via `api.pluginConfig`. The TypeScript type `DeniedPluginConfig` in `src/types.ts` must stay in sync with the JSON Schema in the manifest.

### Claude Code Extension Design

The plugin (`extensions/claude-code`) registers a `PreToolUse` hook via Claude Code's hook system. It is a zero-dependency Node.js script that uses native `fetch` (Node 18+). For each tool call:

1. Claude Code streams the hook context as JSON to stdin (session ID, tool name, tool input, permission mode, cwd)
2. The interceptor builds an AuthZEN evaluation request with subject `claude-code/<sessionId>`, action `execute`, and resource `tool/<toolName>`
3. It sends a POST to the Denied PDP (`/pdp/check`) with the API key in the `X-API-Key` header
4. If the decision is `false`, the tool call is denied and the reason is returned to the agent
5. If the Denied server is unreachable, the plugin follows the `DENIED_FAIL_MODE` setting: `open` (default) allows the call, `closed` denies it

Configuration is via environment variables (`DENIED_API_KEY`, `DENIED_URL`, `DENIED_FAIL_MODE`) — no build step or runtime dependencies required.

### Codex CLI Extension Design

The plugin (`extensions/codex`) registers a `PreToolUse` hook via Codex's hook system. It is a zero-dependency Node.js script (Node 18+) that reuses the same interceptor pattern as the Claude Code extension. For each tool call:

1. Codex streams the hook context as JSON to stdin (session ID, tool name, tool input, permission mode, cwd, tool use ID)
2. The interceptor builds an AuthZEN evaluation request with subject `codex/<sessionId>`, action `execute`, and resource `tool/<toolName>` — the subject `type` is `codex` (vs. `claude-code`) so policies can distinguish agents
3. It sends a POST to the Denied PDP (`/pdp/check`) with the API key in the `X-API-Key` header
4. If the decision is `false`, the tool call is denied via `hookSpecificOutput.permissionDecision: "deny"` and the reason is returned to the agent
5. If the Denied server is unreachable, the plugin follows the `DENIED_FAIL_MODE` setting: `open` (default) allows the call, `closed` denies it

Configuration resolves per-setting in the order: environment variable → JSON config file → built-in default (env always wins). The config file lives at `~/.denied/config.json` (override path with `DENIED_CONFIG`) with keys `apiKey`, `url`, `failMode`, `timeoutMs`. The file fallback exists because Codex's own `config.toml` offers no way to set environment variables for hooks (its `[shell_environment_policy]` only applies to model-run shell commands, not hooks) — so without it, a shell `export` would be the only env option and would need re-running every session. The interceptor's `resolveConfigPath`/`loadFileConfig`/`resolveConfig` are pure and unit-tested.

`hooks/hooks.json` resolves the interceptor path via `${PLUGIN_ROOT}` (Codex's canonical env var for installed plugin roots). Codex requires the user to review and trust the hook definition via the `/hooks` command before it will execute on first run.

The Codex marketplace manifest lives at the repo root in `.agents/plugins/marketplace.json` (Codex's preferred path; differs in schema from Claude's `.claude-plugin/marketplace.json` — the two coexist).

### Publishing

**Python**:

- Version is in `pyproject.toml`
- Build with `python -m build`
- Package is built to `dist/` directory
- Uses hatchling as build backend

**TypeScript**:

- Version is in `package.json`
- `prepublishOnly` script runs `pnpm run build` automatically
- Package includes only `./dist` directory (specified in `files` field)
- Main entry point: `./dist/index.js`
- Type definitions: `./dist/index.d.ts`

**OpenClaw extension**:

- Version is in `extensions/openclaw/package.json`
- Build with `pnpm run build` (runs `tsc`); emits ESM to `dist/` with type declarations. `prepublishOnly` runs the build automatically
- Published as `@denied-dev/denied-openclaw-plugin`. `openclaw.runtimeExtensions` points at the compiled `./dist/index.js` (used by registry installs); `openclaw.extensions` keeps `./index.ts` for local source/dev-link installs. `openclaw.compat.pluginApi` pins the minimum OpenClaw host that supports the compiled runtime loader
- The published package includes `dist` in `files`
- Install via `openclaw plugins install npm:@denied-dev/denied-openclaw-plugin`

**Claude Code extension**:

- No build step — plain JavaScript executed directly by Claude Code's hook runner
- No versioned package; installed as a Claude Code plugin via `claude plugin install`
- Configuration is via environment variables (no package config)

## Error Handling

Both SDKs propagate HTTP errors from the server:

- Python raises `httpx.HTTPStatusError` with response body appended to message
- TypeScript throws `Error` with formatted HTTP status and response data

Validation errors:

- Python raises Pydantic `ValidationError` for invalid schemas
- TypeScript relies on compile-time type checking (no runtime validation)
