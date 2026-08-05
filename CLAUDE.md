# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a monorepo containing SDK implementations for the Denied authorization platform in multiple languages, plus platform extensions:

- **Python SDK** (`/python`): Python 3.10+ client using httpx and Pydantic
- **TypeScript SDK** (`/typescript`): TypeScript/JavaScript client using axios
- **OpenClaw extension** (`/extensions/openclaw`): OpenClaw plugin that enforces authorization on every tool call
- **Claude Code extension** (`/extensions/claude-code`): Claude Code hook plugin that enforces authorization on every tool call
- **Hermes extension** (`/extensions/hermes`): Hermes Agent Python plugin that enforces authorization before tool calls
- **Kiro extension** (`/extensions/kiro`): Kiro IDE and Kiro CLI V3 hook that enforces authorization on every tool call, plus its installer script

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

### Hermes Extension (`/extensions/hermes`)

The Hermes extension is a Python plugin for Hermes Agent. It is part of the root `uv` workspace, and extension checks should run from the repository root:

```bash
# Run Hermes plugin tests
uv run --package denied-hermes-plugin pytest extensions/hermes/tests

# Lint and format-check Hermes plugin code
uv run --package denied-hermes-plugin ruff check extensions/hermes
uv run --package denied-hermes-plugin ruff format --check extensions/hermes

# Type-check Hermes plugin code and tests
uv run --package denied-hermes-plugin pyright extensions/hermes/src/denied_hermes extensions/hermes/tests
```

### Kiro Extension (`/extensions/kiro`)

The Kiro extension is a zero-dependency Node.js hook plus an installer script. Tests use Node's built-in runner, so there is nothing to install first:

```bash
# Run Kiro extension tests
node --test extensions/kiro/hooks/interceptor.test.js extensions/kiro/install.test.js

# Install the gate for Kiro IDE and Kiro CLI V3
node extensions/kiro/install.js

# Preview the plan, verify the install, remove it
node extensions/kiro/install.js --dry-run
node extensions/kiro/install.js --check
node extensions/kiro/install.js --uninstall
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
    ├── hermes/
    │   ├── __init__.py            # Hermes plugin entrypoint exporting register()
    │   ├── plugin.yaml            # Hermes plugin manifest
    │   ├── pyproject.toml         # Python package config
    │   ├── src/denied_hermes/     # Plugin runtime implementation
    │   ├── tests/                 # Pytest coverage
    │   └── README.md              # Plugin documentation
    │
    ├── kiro/
    │   ├── hooks/
    │   │   ├── interceptor.js      # PreToolUse authorization interceptor (zero deps)
    │   │   └── interceptor.test.js # Interceptor unit tests (node --test)
    │   ├── templates/
    │   │   └── hook-v1.json        # v1 hook file template (Kiro IDE + CLI V3)
    │   ├── install.js              # Installer (--workspace/--dry-run/--check/--uninstall)
    │   ├── install.test.js         # Installer unit tests (node --test)
    │   └── README.md               # Plugin documentation
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
   - By default it also extracts the user's most recent prompt from the session transcript (`transcript_path`) and adds it to the check `context` as `last_user_prompt`. Extraction uses a bounded tail read (Strategy B): it reads the final ~64 KB of the JSONL file via an abortable range `createReadStream` and scans backwards for the harness-appended `last-prompt` marker (`{ "type": "last-prompt", "lastPrompt": "..." }`). The read has its own independent deadline (`DEFAULT_READ_TIMEOUT_MS`, ~1s) separate from the PDP fetch timeout, so a stalled filesystem aborts the read instead of blocking the decision. It is best-effort — a missing transcript, parse failure, marker miss, or read timeout omits the field rather than delaying or failing the decision — and is gated by `request.includeLastUserPrompt` (default on). The prompt is kept as a `string` (truncated with an inline marker via `truncatePromptString` when over `maxContextBytes`, rather than the object preview used for `tool_input`/`hook_payload`). The pure `extractLastUserPrompt`/`truncatePromptString` and I/O `readLastUserPrompt` helpers are unit-tested.
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

### Kiro Extension Design

The plugin (`extensions/kiro`) enforces Denied authorization on **Kiro IDE** and **Kiro CLI V3** (`kiro-cli --v3`) via Kiro's native `PreToolUse` hook. It is a zero-dependency Node.js script (Node 18+) that reuses the Codex interceptor pattern. **Kiro CLI V2 (plain `kiro-cli chat`) is deliberately not supported** — see the compatibility note below.

**One interceptor, one file, two surfaces.** Kiro IDE and CLI V3 share a hook schema, a hooks directory, a tool vocabulary and `tool_input` shapes, so a single `~/.kiro/hooks/denied.json` registers both, and V3 honours the global file for the default agent with no flags. The v1 schema is an object containing a **`hooks` array** (not a flat hook object) with `trigger: "PreToolUse"`, a regex `matcher: ".*"`, and `timeout: 20` in **seconds** — set above the interceptor's own 15s PDP deadline so the interceptor, not the host, decides the outcome. The legacy `.kiro/hooks/<name>.kiro.hook` (`when`/`then`) format does not fire on current builds: the installer writes v1 only, and the uninstaller still recognises legacy files.

For each tool call:

1. Kiro streams the hook context as JSON on stdin (`hook_event_name`, `cwd`, `session_id`, `tool_name`, `tool_input`). Every field is treated as optional — `parseHookPayload` degrades an unusable payload to `{}` and the check still goes out, with `context.payload_fidelity` (`full` / `tool_name_only` / `none`) telling the PDP how much of the request was actually visible. `readStdin` carries its own 2s deadline because some builds deliver no stdin at all. There is **no transcript or last-user-prompt enrichment** in this extension, and correspondingly no `request.includeLastUserPrompt` setting.
2. The interceptor builds an AuthZEN evaluation request with subject `kiro/<session_id>`, action `execute`, and resource `tool/<tool_name>`. The subject `type` is `kiro` (vs. `codex`, `claude-code`) so policies can distinguish agents, and `subject.properties` carries `cwd`, `surface` and `session_id_source`. The resource id is the tool name exactly as Kiro sent it; the normalized form travels alongside it as `tool_name_canonical` so policies can match on either.
3. Subject id resolution is a three-tier fallback: `session_id` → a stable per-process id `kiro-<first 12 hex of sha256("<ppid>:<cwd>")>` → `"unknown"`. The second tier must be stable across every tool call of one Kiro process, or log correlation is destroyed; `session_id_source` (`session_id` / `process` / `none`) records which tier produced the id so a degraded identity reads as degraded.
4. It POSTs to the Denied PDP (`/pdp/check`) with the API key in the `X-API-Key` header; `decision: false` blocks the tool call and the reason is returned to the agent.
5. The hook matches all tools (`".*"`). Kiro matchers are regexes over the tool *name* and cannot inspect argument values, so all policy evaluation happens server-side.

**Exit-code contract — the critical Kiro-specific invariant.** The exit code is the entire protocol: `0` allows, `2` blocks on every surface. Any *other* non-zero code blocks in the IDE but only warns in the CLI, so an uncaught Node exception (exit 1) would silently produce fail-closed behaviour in the IDE and fail-open behaviour in the CLI, overriding the configured `failMode` in opposite directions. Every terminal path therefore routes through `exitWith()`, whose code comes from `resolveExitCode()` — only an explicit allow yields 0 and only an explicit deny yields 2; every other outcome (PDP error, malformed response, missing API key, unreadable stdin, watchdog expiry, uncaught exception) resolves through `failMode`. `uncaughtException`/`unhandledRejection` handlers and an 18s self-watchdog (below the hook file's 20s host timeout) close the remaining paths. **stdout is empty on every path** — all surfaces inject hook stdout into the agent's context — so diagnostics and deny reasons go to stderr.

Configuration resolves per-setting in the order **environment variable → JSON config file → built-in default**, at `~/.denied/config.json` (override with `DENIED_CONFIG`) with keys `apiKey`, `url`, `failMode`, `timeoutMs`, plus `request`, `redaction` and `audit` blocks. Only the connection/runtime values have environment overrides: `DENIED_API_KEY`, `DENIED_URL`, `DENIED_FAIL_MODE`, `DENIED_TIMEOUT_MS` (plus `DENIED_CONFIG` for the file path itself). The file is the primary mechanism here rather than a convenience: Kiro documents an `env` key for `mcpServers` but nothing equivalent for hooks, and reaching IDE hooks with an environment variable means `launchctl setenv` plus a restart. The config path is resolved from `os.homedir()` and never from `process.cwd()`, because hook cwd is unreliable in multi-root workspaces. Redaction is **on by default** for Kiro (unlike Codex), because `fs_write` ships whole file bodies and `execute_bash` ships full command lines; it runs *before* truncation so a redacted value cannot resurface inside a bounded preview. It is **key-based only**: values under secret-like *keys* are replaced, and secrets embedded in free-form strings (shell commands, file bodies, URLs) still reach the PDP verbatim — the only way to keep tool inputs on the machine is `request.includeToolInput: false` plus `request.includeHookPayload: false`. Audit records go to `~/.denied/audit/denied-kiro-hook.jsonl`.

`--surface=cli-v2` is the interceptor's only argument: the payload cannot identify the surface, and the flag exists solely to select CLI V2 tool-name normalization (`read`/`write`/`shell` → `read_file`/`fs_write`/`execute_bash`) for a hand-wired, unsupported V2 hook. On the supported surfaces normalization is the identity, and MCP `@server/tool` names always pass through intact.

Decision caching is deliberately disabled: `cache_ttl_seconds` stays at `0`. Its cache key does not include `tool_input`, so it would conflate distinct authorization questions and delay policy revocation.

Kiro has **no plugin or marketplace mechanism** ([#8578](https://github.com/kirodotdev/Kiro/issues/8578)) and Powers cannot carry hooks ([#9007](https://github.com/kirodotdev/Kiro/issues/9007)), so `extensions/kiro/install.js` stages the interceptor to `~/.denied/kiro/interceptor.js`, writes the single hook file with an absolute command path, and supports `--workspace=<path>`, `--dry-run`, `--check` and `--uninstall`. Every file it writes is recorded in `~/.denied/kiro/install-manifest.json`, which is what makes `--uninstall` exact and lets a re-run notice a hand-edited managed file. It preflights for Node 18+ and refuses to install without it (Kiro is a native binary and ships no Node runtime), merges into an existing hook file rather than clobbering it — refusing outright when it cannot parse one — and warns whenever `kiro-cli` is on PATH that V2 sessions are not enforced. `--check` sends a real probe check to the PDP (subject and resource id `denied-install-check`), so it appears in decision logs; it verifies registration on disk, not that a running IDE has loaded the hook. **`--check` records a `[PASS]`/`[FAIL]` per condition and exits 1 on any failure — it never downgrades a fail-open condition to a warning**, because a verification tool that certifies "every prerequisite is in place" while the gate is silently allowing everything is worse than no tool. It fails on: a missing, disabled or mis-wired hook entry (wrong `trigger`, wrong `matcher`, or a `command` not pointing at the staged interceptor), a missing staged interceptor, no Node 18+ on PATH, no API key, an unreachable PDP, and any non-2xx response from `/pdp/check` — 401/403 (rejected credentials), 5xx (server error), or anything else such as a 404 from a `url` that is not a Denied PDP. Reachability ("PDP reachable", proven by *any* HTTP response) and usability ("PDP accepts checks", **2xx only**) are separate results, because the interceptor treats every non-2xx as an error and resolves it through `failMode`. Planning and merge logic is pure and unit-tested, with homedir/cwd/fetch injected so the suite runs against temp directories.

**Compatibility and known gaps** — stated plainly in the README rather than in footnotes:

- **Kiro IDE does not hot-load hooks.** A hook file written while the IDE is running registers nothing and looks exactly like a broken hook. A full restart is mandatory, and it is the first thing to check when a user reports the gate not firing.
- **Kiro CLI V2 is not enforced.** V3 is still early access, so plain `kiro-cli chat` runs V2 and bypasses the gate. The installer warns; the interceptor still normalizes V2 tool names so a hand-wired V2 hook fails loudly rather than silently missing policy.
- **Glob/enumeration is not gateable by tool name.** IDE and CLI V3 compile pattern-matching into `execute_bash` running `find`; only V2 has a real `glob` tool. Enumeration control requires shell-string inspection server-side.
- **The hook file is user-removable.** Kiro has no admin-enforced hook tier ([#7557](https://github.com/kirodotdev/Kiro/issues/7557)). This is a guardrail for a cooperating user or org, not an adversarial-insider control.
- **`KIRO_HOME` does not relocate hooks.** Verified on Kiro CLI 2.16.1 (V3): hooks are read from `~/.kiro/hooks` unconditionally, so the installer writing there is correct. Revisit if [#9148](https://github.com/kirodotdev/Kiro/issues/9148) or [#9075](https://github.com/kirodotdev/Kiro/issues/9075) lands upstream.
- **Platform caveats:** exit-2 blocking is reported broken on Windows ([#8264](https://github.com/kirodotdev/Kiro/issues/8264)), and blocking one tool of a multi-tool turn was reported to crash sessions with a `ValidationException` ([#6342](https://github.com/kirodotdev/Kiro/issues/6342) — did not reproduce on Kiro CLI 2.16.0: a turn with every call denied survived cleanly; the issue remains open upstream).

### Hermes Extension Design

The Hermes extension (`extensions/hermes`) is a Python plugin for Hermes Agent's standard plugin system. Hermes discovers the plugin from `plugin.yaml` and imports `register(ctx)` from `__init__.py`. For each supported tool call:

1. `register(ctx)` constructs `DeniedHermesPlugin` and registers a `pre_tool_call` hook
2. The hook receives Hermes tool metadata (`tool_name`, args, task/session/tool-call ids, and cwd)
3. The mapper builds a Denied `/pdp/check` request with subject `type: "hermes-agent"`, inferred action name/effect, mapped resource, and optional hook payload context
4. The plugin sends the request with `X-API-Key` when configured
5. If the PDP returns `decision: false`, the hook returns `{ "action": "block", "message": "..." }` for Hermes to block the tool call
6. If the PDP returns `decision: true`, the hook returns `None`, so Hermes continues the tool call normally
7. If the PDP is unavailable or returns an invalid response, the hook follows `failMode`: `open` allows, `closed` blocks

Hermes config resolves under the active Hermes profile. `HERMES_HOME` takes precedence, then Hermes' own home helper when available, then `~/.hermes`. The plugin reads environment variables first, then an explicit `DENIED_CONFIG`, then `$HERMES_HOME/denied.json`, then `/opt/data/denied.json`, then built-in defaults.

```json
{
  "url": "https://api.denied.dev",
  "apiKey": "${DENIED_API_KEY}",
  "failMode": "open",
  "timeoutMs": 15000,
  "useSemanticMapping": true,
  "subjectId": "session",
  "request": {
    "includeHookPayload": true,
    "includeToolInput": true,
    "maxContextBytes": 20000
  },
  "redaction": {
    "enabled": true,
    "keys": ["api_key", "apikey", "authorization", "password", "secret", "token"]
  },
  "audit": {
    "enabled": false,
    "includeRawPayload": true,
    "includeMappedRequest": true,
    "includeDecision": true
  }
}
```

Only connection/runtime values have environment overrides: `DENIED_URL`, `DENIED_API_KEY`, `DENIED_FAIL_MODE`, and `DENIED_TIMEOUT_MS`.

`useSemanticMapping` controls whether tool calls map to policy-friendly command/file/url/web-search resources. `subjectId` selects the subject id source: `session`, `task`, or `tool_call`.

The plugin intentionally avoids importing `denied_sdk` at discovery time. Runtime dependencies are imported lazily when the hook is constructed or a tool call is mapped, matching Hermes' optional dependency loading guidance.

Tests inject a fake Denied client and run entirely in process. Keep tests isolated from the developer's real Hermes profile by setting `HERMES_HOME` to a temporary directory.

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

**Hermes extension**:

- Python package metadata is in `extensions/hermes/pyproject.toml`
- Hermes plugin metadata is in `extensions/hermes/plugin.yaml`
- The plugin depends on `denied-sdk` at runtime but loads it lazily
- Current monorepo install flow copies `extensions/hermes` into `$HERMES_HOME/plugins/denied` and enables it with `hermes plugins enable denied`
- A future standalone plugin repository can use `hermes plugins install <owner>/<repo> --enable` when `plugin.yaml` lives at the repository root

**Claude Code extension**:

- No build step — plain JavaScript executed directly by Claude Code's hook runner
- No versioned package; installed as a Claude Code plugin via `claude plugin install`
- Configuration is via environment variables (no package config)

**Kiro extension**:

- No build step — plain JavaScript executed directly by Kiro's hook runner
- No package and no marketplace; installed from a clone with `node extensions/kiro/install.js`, which stages the interceptor to `~/.denied/kiro/` and registers `~/.kiro/hooks/denied.json`
- Configuration lives in `~/.denied/config.json` (Kiro cannot set environment variables for hooks)

## Error Handling

Both SDKs propagate HTTP errors from the server:

- Python raises `httpx.HTTPStatusError` with response body appended to message
- TypeScript throws `Error` with formatted HTTP status and response data

Validation errors:

- Python raises Pydantic `ValidationError` for invalid schemas
- TypeScript relies on compile-time type checking (no runtime validation)
