# Denied SDK Plugin for Kiro

Kiro can execute powerful tools — shell commands, file edits, web fetches, MCP servers, and more. [Denied](https://denied.dev) defines the boundaries of what your Kiro agent can and cannot do: before any tool executes, this plugin checks with the Denied authorization server whether the agent is permitted to run it. If the policy says no, the tool call is blocked and the reason is returned to the agent. You define the boundaries; the plugin enforces them.

## Prerequisites

- [Kiro IDE](https://kiro.dev) and/or [Kiro CLI V3](https://kiro.dev/docs/cli/v3/) (`kiro-cli --v3`) installed and working
- **Node.js 18+, installed separately.** Unlike our other extensions, Kiro is a native binary — it neither bundles nor requires a Node runtime, so the hook command `node <interceptor>` will not run until you install one. Get it from [nodejs.org](https://nodejs.org/) or `brew install node`. The installer preflights for it and refuses to install without it.
- A Denied account and API key. Sign up at [app.denied.dev](https://app.denied.dev)

## Quickstart

### Step 1: Clone the repo and run the installer

```bash
git clone https://github.com/denied-dev/denied-sdk.git
cd denied-sdk
node extensions/kiro/install.js
```

Kiro has no plugin system or marketplace ([#8578](https://github.com/kirodotdev/Kiro/issues/8578)), so the gate is installed by a script rather than by a package manager. The installer stages the interceptor at `~/.denied/kiro/interceptor.js` and registers one hook file at `~/.kiro/hooks/denied.json`. Add `--workspace=.` to also register it in a project's `.kiro/hooks/`.

### Step 2: Set your API key

Create a config file at `~/.denied/config.json` with your API key:

```json
{
  "apiKey": "your-api-key"
}
```

> **Why a file and not just `export DENIED_API_KEY=...`?**
> Kiro provides **no way to set environment variables for hook commands** — there
> is an `env` key for `mcpServers` but nothing equivalent for hooks, and IDE hooks
> inherit the IDE's own environment, which on macOS means `launchctl setenv` plus a
> restart. Here the config file is the primary mechanism, not a convenience.

Environment variables still work and take precedence over the file when both are set — handy for CI or a single CLI run — but an `export` lasts only for that shell session, and the IDE will not see it.

### Step 3: Restart Kiro IDE completely

**Mandatory, and the single most common cause of "it doesn't work."** Kiro loads hooks at startup only. A hook file written while the IDE is running registers nothing, and the result is indistinguishable from a broken install. Quit Kiro entirely — not just a new chat session — and reopen it.

Kiro CLI V3 has no such issue: it picks the hook up on the next `kiro-cli --v3` session.

### Step 4: Verify it's working

```bash
node extensions/kiro/install.js --check
```

When a tool call is blocked, the reason is written to stderr:

```
[denied-dev] Blocked tool call: execute_bash
[denied-dev] Authorization denied by Denied policy engine.
```

## One hook file, two surfaces

Kiro IDE and Kiro CLI V3 share a hook schema, a hooks directory and a tool vocabulary, so a single v1 hook file at `~/.kiro/hooks/denied.json` registers both — V3 honours the global file for the default agent with no flags. That one file is all the installer writes:

```json
{
  "version": "v1",
  "hooks": [
    {
      "name": "denied-authz",
      "description": "Denied authorization gate — blocks tool calls that policy denies",
      "trigger": "PreToolUse",
      "matcher": ".*",
      "action": {
        "type": "command",
        "command": "node \"/Users/<you>/.denied/kiro/interceptor.js\""
      },
      "timeout": 20,
      "enabled": true
    }
  ]
}
```

To install by hand: copy `extensions/kiro/hooks/interceptor.js` somewhere stable, write the file above with an **absolute** path to it (a `~` is not expanded inside the quoted command), and restart Kiro. `timeout` is in seconds and is deliberately set above the interceptor's own 15s PDP deadline, so the interceptor decides the outcome rather than inheriting Kiro's timeout behaviour. A legacy `.kiro/hooks/<name>.kiro.hook` format (`when`/`then`) also exists in older workspaces but does not fire on current builds — write v1 only; `--uninstall` still cleans up legacy Denied files if you have them.

## Compatibility

| Surface                                    | Enforced           | Notes                                                          |
| ------------------------------------------ | ------------------ | -------------------------------------------------------------- |
| **Kiro IDE**                               | ✅ Yes             | Requires a full IDE restart after install                      |
| **Kiro CLI V3** (`kiro-cli --v3`)          | ✅ Yes             | Global `~/.kiro/hooks/` honoured for the default agent          |
| **Kiro CLI V2** (plain `kiro-cli chat`)    | ❌ **Not enforced** | Tool calls bypass the gate entirely                            |

Kiro CLI V3 is still early access, which means **`kiro-cli chat` with no flag runs V2 and gets no enforcement**. V2 is a separate agent engine with its own tool vocabulary, its own `tool_input` shapes and no global hook location, so we deliberately do not install it. The installer warns explicitly whenever it finds `kiro-cli` on your PATH; a successful install never implies V2 coverage. Run `kiro-cli --v3` for a covered session.

### Unsupported: wiring V2 by hand

If you want V2 coverage anyway, add this to a **specific** agent config at `~/.kiro/agents/<name>.json`. It is unsupported: we neither install nor test it.

```json
{
  "hooks": {
    "preToolUse": [
      {
        "command": "node \"/Users/<you>/.denied/kiro/interceptor.js\" --surface=cli-v2",
        "timeout_ms": 20000,
        "cache_ttl_seconds": 0
      }
    ]
  }
}
```

`--surface=cli-v2` is load-bearing: it tells the interceptor to normalize V2's `read`/`write`/`shell` onto the `read_file`/`fs_write`/`execute_bash` names your IDE/V3 policies are written against. Without it, the tool names reaching the PDP silently miss policy — the exact fail-open this gate exists to prevent. The matcher is omitted on purpose (no matcher means all tools). Three caveats: it covers only the agents you patch, the default agent cannot be covered without replacing it, and coverage decays silently as you add agents.

## Configuration reference

Settings resolve in this order: **environment variable** → **config file** → built-in default. Environment variables always win when present.

| Environment variable | Config file key (`~/.denied/config.json`) | Default                                                            | Description                                                                          |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `DENIED_API_KEY`     | `apiKey`                                   | —                                                                  | Required. API key for the Denied PDP.                                                |
| `DENIED_URL`         | `url`                                      | `https://api.denied.dev`                                           | PDP endpoint. Only change for custom deployments.                                    |
| `DENIED_FAIL_MODE`   | `failMode`                                 | `open`                                                             | `open` = allow on error, `closed` = deny when PDP is unreachable.                    |
| `DENIED_TIMEOUT_MS`  | `timeoutMs`                                | `15000`                                                            | Timeout in milliseconds.                                                             |
| `DENIED_CONFIG`      | —                                          | `~/.denied/config.json`                                            | Path to the JSON config file. Set to read config from elsewhere.                     |
| —                    | `request.includeToolInput`                 | `true`                                                             | Send the raw tool arguments as bounded resource context.                             |
| —                    | `request.includeHookPayload`               | `true`                                                             | Send the whole hook payload as bounded request context.                              |
| —                    | `request.maxContextBytes`                  | `20000`                                                            | Oversized values are replaced with a `{ "truncated": true, ... }` preview.           |
| —                    | `redaction.enabled`                        | `true`                                                             | Replace values of secret-like keys with `[REDACTED]` before anything leaves the box. |
| —                    | `redaction.keys`                           | `["api_key","apikey","authorization","password","secret","token"]` | Matched case- and punctuation-insensitively, as a substring of the key.              |
| —                    | `audit.enabled`                            | `false`                                                            | Write local JSONL debug records to `<audit.dir>/denied-kiro-hook.jsonl`.             |
| —                    | `audit.dir`                                | `~/.denied/audit`                                                  | Where audit records are written.                                                     |
| —                    | `audit.includeRawPayload`                  | `true`                                                             | Include the hook payload in each audit record.                                       |
| —                    | `audit.includeMappedRequest`               | `true`                                                             | Include the AuthZEN request that was sent.                                           |
| —                    | `audit.includeDecision`                    | `true`                                                             | Include the PDP response.                                                            |

Example `~/.denied/config.json`:

```json
{
  "apiKey": "your-api-key",
  "url": "https://api.denied.dev",
  "failMode": "open",
  "timeoutMs": 15000,
  "request": {
    "includeToolInput": true,
    "includeHookPayload": true,
    "maxContextBytes": 20000
  },
  "redaction": {
    "enabled": true,
    "keys": ["api_key", "apikey", "authorization", "password", "secret", "token"]
  },
  "audit": { "enabled": false, "dir": "~/.denied/audit" }
}
```

**Redaction is on by default here, unlike our other extensions.** Kiro's `fs_write` carries whole file bodies in `tool_input` and `execute_bash` carries full command lines, so a `.env` write or a `curl -H "Authorization: ..."` would otherwise be shipped verbatim. Redaction runs before truncation, so a secret cannot survive inside a truncated preview.

> **Security note:** Audit logs may contain sensitive data. When `audit.enabled` is true, `audit.includeRawPayload`, `audit.includeMappedRequest`, `request.includeToolInput`, and `request.includeHookPayload` default to `true`, so audit records can include full tool inputs, hook payloads, file contents, shell commands, URLs, and credentials. Store audit logs only in a location with appropriate access controls.

## How it works

For each tool call, Kiro streams the hook context to the interceptor as JSON on stdin, and the interceptor sends an authorization check to the Denied server:

- **Subject**: `kiro://<session_id>`, with `cwd`, `surface` and `session_id_source` as properties. If the payload carries no session id, the interceptor falls back to a stable per-process id (`kiro-<12 hex>`, derived from the parent PID and the working directory) so the tool calls of one Kiro process still correlate, and then to `unknown`. `session_id_source` records which tier produced it (`session_id`, `process`, `none`), so a degraded identity reads as degraded rather than as a real session.
- **Action**: `execute`
- **Resource**: `tool://<tool_name>` — the name exactly as Kiro sent it — with `tool_name_canonical` and, by default, bounded `tool_input` as properties
- **Context**: the integration name, the hook event, and `payload_fidelity` (`full` / `tool_name_only` / `none`), plus the bounded hook payload by default

The hook matches every tool (`".*"`). Kiro's matchers are regexes over the tool *name* and cannot inspect argument values, so **all policy evaluation happens server-side** — narrowing the matcher would only create blind spots. `payload_fidelity` exists so a policy can say "if I cannot see the arguments, deny" instead of leaving the PDP to guess whether an empty `tool_input` means a tool that takes no arguments or a payload that could not be read.

The exit code is the entire protocol: `0` allows, `2` blocks. Nothing is ever written to stdout — every Kiro surface injects hook stdout into the agent's context — so diagnostics go to stderr, and a denial's reason reaches the agent that way.

## Default behavior

**Default-deny**: With no policies configured in Denied, every tool call is blocked. This is intentional — you must explicitly define the boundaries for your agent by creating policies in the [Denied dashboard](https://app.denied.dev).

**Fail-open on error**: If the Denied server is unreachable (network issue, server down) or no API key is configured, tool calls are allowed through. This prevents the plugin from completely breaking the agent. Set `DENIED_FAIL_MODE=closed` for stricter enforcement. You'll see log entries like:

```
[denied-dev] Failed to reach Denied PDP: fetch failed
```

Every path that is not an explicit allow or deny — PDP error, malformed response, missing API key, unreadable stdin, an internal watchdog firing at 18s, even an uncaught exception — resolves through `failMode` and exits either 0 or 2. The interceptor never leaks any other exit code, because a stray exit 1 would block in the IDE while merely warning in the CLI, silently overriding your `failMode` in opposite directions on the two surfaces.

## Creating policies

After installing the plugin, all tool calls are blocked by default. You need to create policies to define what your agent is allowed to do.

Every blocked tool call is logged as an authorization decision in the [Denied dashboard](https://app.denied.dev). These decision logs capture the full context of each request — the session identity, the tool name, and the parameters (command, file path, etc.). The dashboard's AI policy generator can read those logs and produce least-privilege policies for you, so you can start with default-deny, let the agent run into the boundaries, then turn the decision log into precise allow rules.

## Installer reference

```bash
node extensions/kiro/install.js [--workspace=<path>] [--dry-run] [--check] [--uninstall]
```

| Flag                 | What it does                                                                            |
| -------------------- | --------------------------------------------------------------------------------------- |
| _(none)_             | Install: stage the interceptor, write `~/.kiro/hooks/denied.json`, record a manifest.    |
| `--workspace=<path>` | Also register the hook in `<path>/.kiro/hooks/denied.json`.                              |
| `--dry-run`          | Print the plan and write nothing. Combines with `--uninstall`.                           |
| `--check`            | Verify the gate is registered and every prerequisite is in place.                        |
| `--uninstall`        | Remove the gate. Never touches `~/.denied/config.json`.                                  |

Everything the installer writes is recorded in `~/.denied/kiro/install-manifest.json`, which is what makes `--uninstall` exact and what lets a re-run notice you hand-edited a managed file. If `~/.kiro/hooks/denied.json` already holds hooks of your own, they are preserved and the file is backed up before it is rewritten; if it cannot be parsed, the install refuses and writes nothing.

> **`--check` performs a real authorization check.** It POSTs to your PDP with subject and resource id `denied-install-check` to prove reachability, so the probe will appear in your Denied decision logs. Note also what `--check` cannot tell you: it verifies that the hook is registered on disk, not that a currently running Kiro IDE has loaded it.

## Known limitations

Stated plainly, because a security control that overstates its coverage is worse than one that does not exist.

- **There is no `glob` tool to gate on the supported surfaces.** Kiro IDE and CLI V3 compile pattern-matching into `execute_bash` running `find`; only the unsupported V2 has a real `glob` tool. A policy that gates `glob` gates nothing here — real enumeration control requires inspecting the shell string server-side.
- **The hook file is user-removable.** Kiro has no admin-enforced hook tier ([#7557](https://github.com/kirodotdev/Kiro/issues/7557)), so anyone who can write `~/.kiro/hooks/` can delete the gate. This is a guardrail for a cooperating user or organization, not an adversarial-insider control. Keeping Kiro's default deny on writes to `.kiro/hooks/**` gives partial tamper-resistance.
- **Windows CLI blocking is reported broken.** Exit 2 does not block on Windows 11 ([#8264](https://github.com/kirodotdev/Kiro/issues/8264)). Treat Windows as unverified: the hook runs, but do not assume it enforces.
- **Denying inside a multi-tool turn was reported to crash sessions** with a `ValidationException` ([#6342](https://github.com/kirodotdev/Kiro/issues/6342), still open upstream). This did not reproduce in our testing: on Kiro CLI 2.16.0 (V3), a three-call turn with every call denied survived cleanly and the session stayed usable. If you hit it on an older build, no client-side fix exists.
- **Decision caching is deliberately disabled** (`cache_ttl_seconds` stays `0`). Kiro's hook cache key does not include `tool_input`, so `git status` and `rm -rf /` are the same cache entry — and any TTL would delay a policy change or a revoked key by that long. The PDP call is one HTTPS round trip on a path already waiting on an LLM.

## Troubleshooting

| Symptom                                        | Meaning                                        | Fix                                                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Hook never fires, tools run freely (IDE)       | You installed while Kiro was running           | **Quit Kiro IDE completely and reopen it.** Hooks load at startup only. Then confirm with `node extensions/kiro/install.js --check`.            |
| Agent Hooks panel is empty                     | Not evidence the hook is missing               | Kiro may not re-scan the hooks directory until a filesystem event. Trust `--check` and an actual tool call over the panel.                       |
| `Blocked tool call: <name>`                    | Policy denied the tool call                    | Working as intended. Create an allow policy in the [Denied dashboard](https://app.denied.dev) if the tool should be permitted.                   |
| `No API key found`                             | No API key configured                          | Add `apiKey` to `~/.denied/config.json` (recommended). An `export` will not reach IDE hooks.                                                     |
| `Ignoring malformed config file`               | `~/.denied/config.json` isn't valid JSON       | Fix the JSON syntax, or delete the file to fall back to env vars/defaults.                                                                       |
| `Failed to reach Denied PDP: ...`              | Plugin can't reach the Denied server           | Check `DENIED_URL` is correct and network connectivity.                                                                                          |
| `HTTP 401` or `403`                            | Invalid or missing API key                     | Check `apiKey` in `~/.denied/config.json` or the `DENIED_API_KEY` env var.                                                                       |
| Tools run freely in `kiro-cli chat`            | That session is V2, which is not enforced      | Start the session with `kiro-cli --v3`. See [Compatibility](#compatibility).                                                                     |
| Installer errors on Node                       | Node.js 18+ is not on your PATH                | Kiro ships no Node runtime. Install from [nodejs.org](https://nodejs.org/) and re-run the installer.                                              |

## Uninstalling

```bash
node extensions/kiro/install.js --uninstall
```

This removes the `denied-authz` entry (leaving any other hooks in the file intact), deletes `~/.denied/kiro/`, and leaves `~/.denied/config.json` alone in case you still want the API key. Backups from earlier installs are left in place — remove them by hand if you don't want them.

Restart Kiro IDE afterwards: a running IDE keeps the hook it loaded at startup, so the gate stays active until you do.

## Links

- [Kiro](https://kiro.dev) — AWS's agentic IDE and CLI
- [Kiro CLI V3](https://kiro.dev/docs/cli/v3/) — the enforced CLI surface
- [Denied](https://denied.dev) — Define the boundaries of AI agents
- [Denied Dashboard](https://app.denied.dev) — Manage policies and API keys
