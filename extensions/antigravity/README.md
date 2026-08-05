# Denied SDK Plugin for Google Antigravity

Antigravity agents can execute powerful tools — shell commands, file edits, web fetches, subagents, MCP servers. [Denied](https://denied.dev) defines the boundaries of what your agent can and cannot do: before a tool executes, this plugin checks with the Denied authorization server whether the agent is permitted to run it. If the policy says no, the tool call is blocked and the reason is returned to the agent. You define the boundaries; the plugin enforces them.

## Coverage — read this first

**Preventive enforcement covers the `agy` CLI only.**

| Surface                                | Enforced                | Notes                                                                                   |
| -------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| **`agy` CLI**                          | ✅ Yes                  | Hook fires, `deny` hard-blocks with no approval prompt (verified on agy 1.1.10)          |
| **Antigravity IDE** (VS Code fork)     | ❌ **Not enforced**     | The IDE does not execute hooks at all (verified on 2.1.1, 2026-08-04/05)                 |
| **Antigravity 2.0** (desktop app)      | ❌ **Not enforced**     | Same — no hook execution (verified on desktop 2.5.0, 2026-08-04/05)                      |

We tested the GUI surfaces empirically: workspace `.agents/hooks.json`, global `~/.gemini/config/hooks.json`, and a plugin-root registration, installed simultaneously, folder trusted, full app restarts, driving both `run_command` and file read/write — **zero hook invocations**, while the `agy` CLI control fired throughout under the identical global registration. This is a product gap in Antigravity, not a registration error.

The installer therefore writes the registration **globally**, where all three surfaces read it. On the GUI it is installed but dormant, and it starts enforcing automatically if and when Google ships GUI hook execution. Until then: do not claim, and do not assume, that an Antigravity IDE or Antigravity 2.0 session is gated. Re-probe on every release — see [Per-release re-probe checklist](#per-release-re-probe-checklist).

## Prerequisites

- [Antigravity `agy` CLI](https://antigravity.google/docs/cli) installed and working
- Node.js 18+ on the machine (the installer resolves an absolute interpreter path; if no `node` is on `PATH` it falls back to Antigravity's own bundled `agy-node` shim)
- macOS or Linux. **Windows is not supported** — Antigravity hook execution is broken there ([#222](https://github.com/google-antigravity/antigravity-cli/issues/222)), and the installer refuses to run
- A Denied account and API key. Sign up at [app.denied.dev](https://app.denied.dev)

## Quickstart

### Step 1: Clone the repo and run the installer

```bash
git clone https://github.com/denied-dev/denied-sdk.git
cd denied-sdk/extensions/antigravity
./install.sh
```

Antigravity has no plugin marketplace and no remote install path, so the gate is installed by a script. The installer stages the interceptor at `~/.denied/antigravity/interceptor.js` and merges a `denied-authz` hook group into `~/.gemini/config/hooks.json` with an **absolute** command path. Other hook groups in that file are preserved.

```
./install.sh [--scope global|workspace|both] [--workspace PATH] [--node PATH] [--dry-run]
```

| Flag                | What it does                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------- |
| _(none)_            | Install at global scope: `~/.gemini/config/hooks.json`.                                   |
| `--scope`           | `global` (default), `workspace` (`<path>/.agents/hooks.json`), or `both`.                 |
| `--workspace PATH`  | Workspace root for workspace scope. Defaults to the current directory.                    |
| `--node PATH`       | Use this Node interpreter instead of the auto-resolved one.                               |
| `--dry-run`         | Print the exact JSON that would be written and change nothing.                            |

After writing, the installer runs a self-check probe and warns if `~/.denied/config.json` has no `apiKey`.

**Workspace scope requires folder trust.** Antigravity does not load `<workspace>/.agents/hooks.json` until you have trusted that folder, and an untrusted folder looks exactly like a broken install.

**Restart any running `agy` session.** Hook registration is read at session start.

### Step 2: Set your API key

Create `~/.denied/config.json`:

```json
{
  "apiKey": "your-api-key"
}
```

`export DENIED_API_KEY=...` also works, and takes precedence — verified on agy 1.1.10, hook environments are **not** sanitized on the CLI. But an export lasts only for the shell that launched the session, whereas the config file survives non-shell launches and is the only mechanism that would ever reach GUI surfaces. Use the file for anything durable.

### Step 3: Verify it's working

Ask the agent to run a command. With no policies configured, it is denied, and the reason is surfaced to the agent inline. On stderr you will see:

```
[denied-dev] Blocked tool call: run_command
[denied-dev] Authorization denied by Denied policy engine.
```

### Manual installation (fallback)

Copy `extensions/antigravity/hooks/interceptor.js` somewhere stable, then write this into `~/.gemini/config/hooks.json` (global) or `<workspace>/.agents/hooks.json`, **replacing both placeholder paths with real absolute paths**:

```json
{
  "denied-authz": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/node /Users/you/.denied/antigravity/interceptor.js",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The template committed at `extensions/antigravity/hooks.json` ships a deliberately invalid placeholder command so that pasting it unedited fails loudly. **Get the paths wrong and the failure is silent and version-dependent**: on agy ≤1.1.7 an unrunnable hook command denied every tool call; on 1.1.10 it silently allows everything. Antigravity has no `${PLUGIN_ROOT}`-style interpolation, `~` inside the command is expanded by the shell but relative paths resolve against the directory containing `hooks.json`, so absolute paths are mandatory. `timeout` is in seconds and is deliberately set below Antigravity's 30s default so the interceptor's own 8s watchdog always wins.

`hooks.json` is a **map of named hook groups**, not a flat event map, and it sits at the plugin root — never inside `hooks/`. `plugin.json` carries **only** `name` and `description`; adding a Claude-Code-style `"hooks": "hooks.json"` key is a known cause of hooks that silently never fire.

## Configuration reference

Settings resolve in this order: **environment variable** → **`$DENIED_CONFIG`** → **`~/.denied/config.json`** → built-in default. Environment variables always win when present. Only the connection and runtime values have environment overrides.

| Environment variable | Config file key (`~/.denied/config.json`) | Default                                                            | Description                                                                              |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `DENIED_API_KEY`     | `apiKey`                                   | —                                                                  | Required. API key for the Denied PDP.                                                    |
| `DENIED_URL`         | `url`                                      | `https://api.denied.dev`                                           | PDP endpoint. Only change for custom deployments.                                        |
| `DENIED_FAIL_MODE`   | `failMode`                                 | `open`                                                             | `open` allows on error, `closed` denies, `ask` defers to the user (see below).            |
| `DENIED_TIMEOUT_MS`  | `timeoutMs`                                | `5000`                                                             | PDP fetch timeout. Clamped to 5000 ms to fit the watchdog, with a warning on stderr.      |
| `DENIED_CONFIG`      | —                                          | `~/.denied/config.json`                                            | Path to the JSON config file. Resolved from your home directory, never from `cwd`.        |
| —                    | `surface`                                  | `unknown`                                                          | `cli` / `ide` / `app`. **Fallback only** — normally derived from the payload paths.       |
| —                    | `request.includeToolInput`                 | `true`                                                             | Send the tool arguments as bounded resource context.                                     |
| —                    | `request.includeHookPayload`               | `true`                                                             | Send the whole hook payload as bounded request context.                                  |
| —                    | `request.includeLastUserPrompt`            | `true`                                                             | Best-effort transcript read for the last user prompt (caveats below).                    |
| —                    | `request.maxContextBytes`                  | `20000`                                                            | Oversized values are replaced with a `{ "truncated": true, ... }` preview.               |
| —                    | `redaction.enabled`                        | `true`                                                             | Replace secret-like values with `[REDACTED]` before anything leaves the box.             |
| —                    | `redaction.keys`                           | `["api_key","apikey","authorization","password","secret","token"]` | Matched case- and punctuation-insensitively, as a substring of the key.                  |
| —                    | `audit.enabled`                            | `false`                                                            | Write local JSONL records to `<audit.dir>/denied-antigravity-hook.jsonl`.                |
| —                    | `audit.dir`                                | `~/.denied/audit`                                                  | Where audit records are written.                                                          |
| —                    | `audit.includeRawPayload`                  | `true`                                                             | Include the hook payload in each audit record.                                            |
| —                    | `audit.includeMappedRequest`               | `true`                                                             | Include the AuthZEN request that was sent.                                                |
| —                    | `audit.includeDecision`                    | `true`                                                             | Include the PDP response.                                                                 |

Example `~/.denied/config.json`:

```json
{
  "apiKey": "your-api-key",
  "url": "https://api.denied.dev",
  "failMode": "open",
  "timeoutMs": 5000,
  "request": {
    "includeToolInput": true,
    "includeHookPayload": true,
    "includeLastUserPrompt": true,
    "maxContextBytes": 20000
  },
  "redaction": {
    "enabled": true,
    "keys": ["api_key", "apikey", "authorization", "password", "secret", "token"]
  },
  "audit": { "enabled": false, "dir": "~/.denied/audit" }
}
```

### Redaction

**Redaction is on by default** on this platform, because `run_command` ships whole command lines and `write_to_file` ships whole file bodies. It runs *before* truncation, so a redacted value cannot resurface inside a bounded preview. Two mechanisms:

- **Key-based:** any value whose JSON key matches a configured secret-like name (`authorization`, `api_key`, `password`, `token`, …) becomes `[REDACTED]`.
- **String patterns:** three patterns are also scrubbed inside free-form strings — `Authorization: Bearer …` headers, `key=value` pairs for secret-like keys, and `--api-key value` / `--token value` style flags.

That is not full coverage. A secret embedded in arbitrary shell text, a file body, or a URL query in a shape the three patterns do not match **still reaches the PDP verbatim**. The only way to keep tool inputs on the machine is to set both `request.includeToolInput` and `request.includeHookPayload` to `false`.

> **Security note:** Audit logs may contain sensitive data. When `audit.enabled` is true, `audit.includeRawPayload`, `audit.includeMappedRequest`, `request.includeToolInput`, and `request.includeHookPayload` default to `true`, so audit records can include full tool inputs, hook payloads, file contents, shell commands, URLs, and credentials. Store audit logs only in a location with appropriate access controls.

### `last_user_prompt`

When `request.includeLastUserPrompt` is on (the default), the interceptor does a bounded, abortable tail read of the session transcript and puts the most recent user prompt into the check context. Its schema was pinned empirically on agy 1.1.10 and is not documented by Google. Three caveats matter for policy authors:

- **It may be absent.** A missing transcript, an unexpected schema, or the 1s read deadline omits the field rather than delaying the decision.
- **It may be stale.** Whether the transcript is flushed to disk before the turn's first tool call reaches the hook is **unverified**. If it is not, the field carries the *previous* turn's prompt — confidently wrong rather than empty.
- **In a subagent conversation it is model-authored.** The subagent transcript's "user prompt" is the parent's `invoke_subagent` prompt argument, and nothing in the record distinguishes it from human input. Do not write policies that treat `last_user_prompt` as verified human intent.

Set `request.includeLastUserPrompt: false` to drop the field entirely.

## How it works

Antigravity streams the hook context to the interceptor as JSON on stdin. The interceptor sends one authorization check to the Denied server and prints one decision on stdout:

- **Subject**: `antigravity://<conversationId>`, with `surface` (`cli` / `ide` / `app`, derived from the profile directory in the payload paths), `workspace_paths`, `cwd`, `step_idx` and `model_name` as properties
- **Action**: `execute`, with an inferred `effect` (`read` / `create` / `update` / `delete` / `execute`) and the `tool_name` as properties
- **Resource**: `tool://<toolCall.name>` — the name exactly as Antigravity sent it — with bounded `tool_input` as a property by default
- **Context**: the integration name, the hook event (hardcoded — Antigravity does not put it in the payload), `artifact_directory_path`, plus the bounded hook payload and `last_user_prompt` by default

The hook matches every tool (`"*"`). All policy evaluation happens server-side.

### Emitted decisions

Exactly one of:

```json
{"decision":"allow"}
{"decision":"deny","reason":"..."}
{"decision":"force_ask","reason":"..."}
```

`force_ask` is emitted only under `failMode: "ask"`. The interceptor **never** emits `{"decision":"block"}` — `block` is not a real value, it produces `Error: unknown pre-tool hook decision "block"` and fails closed. It never emits `{}` — that is not an allow, it denies. And it never emits `permissionOverrides`, which would write durable cached grants, i.e. cache an authorization decision.

### The exit-code contract: we never let the host decide

**Antigravity's hook-failure semantics are undocumented and version-unstable.** On agy ≤1.1.7 a broken hook (non-zero exit, empty stdout, timeout) **denied** the tool call. On 1.1.10 all three of those **silently allow** it. The flip shipped with no changelog entry. Meanwhile schema-level failures (`{}`, an unrecognized `decision`) still fail closed. Neither direction can be relied on, and it can flip again.

So the interceptor never returns a failure to the host. Every code path — crash, unhandled rejection, PDP down, PDP slow, malformed config, missing API key, unreadable stdin, watchdog expiry — **exits 0 and prints exactly one well-formed decision object**, chosen by your `failMode`. stdout carries the decision and nothing else; all diagnostics go to stderr, because a stray log line corrupts the payload into a denial.

**What this means if you run `failMode: closed`:** a naive hook that crashed would, on today's builds, silently stop enforcing — your gate would be wide open and nothing would say so. This one emits `{"decision":"deny"}` from the crash handler, the rejection handler, and the watchdog, so enforcement survives the failure. Under `failMode: open` the same paths emit `allow`, so a Denied outage never bricks your agent.

### Timeout budget

Four nested deadlines, all strictly inside the hook timeout:

| Deadline                        | Value  | Set where                     |
| ------------------------------- | ------ | ----------------------------- |
| Host hook `timeout`             | 10 s   | `hooks.json`                  |
| Interceptor watchdog            | 8 s    | fixed in the interceptor      |
| stdin read                      | 2 s    | fixed in the interceptor      |
| PDP fetch (`timeoutMs`)         | 5 s    | config, clamped to ≤ 5000 ms  |
| Transcript tail read            | 1 s    | fixed in the interceptor      |

The invariant is `stdin + fetch + transcript ≤ watchdog < host timeout`, so a stall always resolves into *our* fail-safe decision rather than the host's current mood. A `timeoutMs` above the budget is clamped, with a warning on stderr.

## Default behavior

**Default-deny**: with no policies configured in Denied, every tool call is blocked. This is intentional — define the boundaries for your agent by creating policies in the [Denied dashboard](https://app.denied.dev).

**Fail-open on error** (default): if the Denied server is unreachable or no API key is configured, tool calls are allowed through, with the reason on stderr:

```
[denied-dev] Failed to reach Denied PDP: fetch failed
```

Set `failMode: "closed"` for strict enforcement, or `failMode: "ask"` for the middle ground — PDP-unavailable maps to `force_ask`, which prompts you instead of silently allowing or hard-blocking. `ask` is opt-in only: Denied is a decision point, and downgrading a decision to "ask the human" turns an enforced policy into a suggestion.

## Creating policies

After installing, all tool calls are blocked by default. Every blocked call is logged as an authorization decision in the [Denied dashboard](https://app.denied.dev), capturing the conversation identity, the tool name, and the parameters. The dashboard's AI policy generator reads those logs and produces least-privilege policies, so you can start default-deny, let the agent hit the boundaries, then turn the decision log into precise allow rules.

## Known limitations

Stated plainly, because a security control that overstates its coverage is worse than one that does not exist.

- **The GUI surfaces are not enforced.** Antigravity IDE 2.1.1 and Antigravity 2.0 desktop 2.5.0 execute no hooks at all. A detective (audit-only) layer over the session transcript is a future milestone; today there is no preventive control there.
- **Denied agents may fabricate results.** After several denials in one turn, the CLI agent has been observed to stop retrying and *invent plausible answers* — reporting a `pwd` and a `whoami` value it never obtained, inferred from session context. This is why every deny carries a `reason` (a reason-less denial makes it worse). Treat a confident answer that follows a denial with suspicion, and check the decision log.
- **Subagents are distinct subjects.** A subagent's tool calls arrive under its own new `conversationId` with **no parent id in the payload** (parentage is only inferable from a later `send_message.Recipient`). A policy keyed to one conversation does not automatically extend to its subagents. The subagent's own internal tool calls *are* individually hooked — verified — so a subagent is not a route around policy.
- **A deny on subagent *dispatch* may be ignored** ([#640](https://github.com/google-antigravity/antigravity-cli/issues/640), open). Gate what a subagent *does*, not the spawn. A live deny-mode run confirms this is sufficient: with `run_command` denied, an `invoke_subagent` dispatch was allowed through, the subagent's own `run_command` was blocked under its own `conversationId`, and the command never executed.
- **Windows is unsupported.** Hook execution is broken upstream ([#222](https://github.com/google-antigravity/antigravity-cli/issues/222), [#257](https://github.com/google-antigravity/antigravity-cli/issues/257), [#49](https://github.com/google-antigravity/antigravity-cli/issues/49)). The installer refuses to run.
- **Glob-style enumeration is not gateable by tool name.** Pattern-matching requests compile down to `run_command` on some surfaces, so enumeration control requires inspecting the shell string server-side.
- **The hook file is user-removable.** Anyone who can write `~/.gemini/config/hooks.json` can delete the gate. This is a guardrail for a cooperating user or organization, not an adversarial-insider control.

## Per-release re-probe checklist

Antigravity's hook behaviour has changed silently — once for failure semantics, and GUI execution could appear the same way. Re-run these on **every** `agy`, Antigravity IDE, and Antigravity 2.0 release.

Use a probe hook that writes a marker file and prints `{"decision":"allow"}`; swap to `{"decision":"deny","reason":"probe"}` to test blocking. **Never probe with `{"decision":"block"}`** — it is not a valid value, it errors, and it fails closed.

1. **Registration matrix.** Workspace `.agents/hooks.json`, global `~/.gemini/config/hooks.json`, and the plugin-root route, each against the IDE, Antigravity 2.0, and the `agy` CLI (control — must fire). Trust the folder before testing workspace scope. Drive both `run_command` and file read/write.
2. **Failure-regime probes** on the CLI: hook command `sh -c 'exit 1'` (non-zero exit), `sh -c 'true'` (exit 0, empty stdout), and `sh -c 'sleep 60'` against a `timeout: 10`. Record for each whether the tool ran (fail open) or was denied (fail closed). All three failed **open** on 1.1.10 and **closed** on ≤1.1.7.
3. **Deny-hardness check.** Confirm a `{"decision":"deny"}` still hard-blocks and does not degrade into a user-approvable prompt.

Revisit triggers — check these each planning cycle:

- Any Antigravity changelog entry on the **IDE or 2.0 track** mentioning hooks, `PreToolUse`, or plugin hooks (the IDE track has been silent on hooks since 2.1.1).
- A resolution or Google reply on [forum thread 176814](https://discuss.ai.google.dev/t/do-antigravity-ide-2-0-actually-execute-plugin-hooks-pretooluse-posttooluse-or-is-that-cli-only-right-now/176814).
- [antigravity-cli#628](https://github.com/google-antigravity/antigravity-cli/issues/628) (hard deny), [#528](https://github.com/google-antigravity/antigravity-cli/issues/528) (cross-platform blocking hook surface), or [#640](https://github.com/google-antigravity/antigravity-cli/issues/640) (subagent dispatch) being closed.
- Any documented extension API or **enterprise admin control** for the IDE — Antigravity's enterprise docs currently exclude the IDE.
- The `google-antigravity` **Python SDK** gaining Connection-level or out-of-process policy registration.

## Troubleshooting

| Symptom                                           | Meaning                                        | Fix                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Tools run freely in the IDE or Antigravity 2.0    | Those surfaces do not execute hooks            | Expected. See [Coverage](#coverage--read-this-first). Use the `agy` CLI for enforced sessions.                              |
| Hook never fires in `agy`                         | Registration not loaded, or wrong path         | Restart the session; re-run `./install.sh --dry-run` to see the exact command; for workspace scope, trust the folder.        |
| `Blocked tool call: <name>`                       | Policy denied the tool call                    | Working as intended. Create an allow policy in the [Denied dashboard](https://app.denied.dev).                              |
| Agent answers confidently right after a denial    | Possible confabulation                         | Do not trust the answer. Check the Denied decision log for what actually ran.                                                |
| `No API key found`                                | No API key configured                          | Add `apiKey` to `~/.denied/config.json` (recommended), or `export DENIED_API_KEY` in the shell that launches `agy`.          |
| `Ignoring malformed config file`                  | `~/.denied/config.json` isn't valid JSON       | Fix the JSON syntax, or delete the file to fall back to env vars and defaults.                                              |
| `Failed to reach Denied PDP: ...`                 | Can't reach the Denied server                  | Check `url`/`DENIED_URL` and network connectivity. Behaviour on failure follows `failMode`.                                 |
| `HTTP 401` or `403`                               | Invalid or missing API key                     | Check `apiKey` in `~/.denied/config.json` or the `DENIED_API_KEY` env var.                                                  |
| `timeoutMs ... exceeds the ... watchdog budget`   | Configured timeout too large                   | Informational — it was clamped. Lower `timeoutMs` to 5000 or less to silence it.                                            |
| `Watchdog fired after 8000ms`                     | Something stalled                              | The configured `failMode` decision was emitted. Check PDP reachability and filesystem responsiveness.                       |
| Tool calls succeed but no decisions appear in the log | A stale `DENIED_*` env var is overriding your config file | Run `env \| grep DENIED_`. Environment variables beat `~/.denied/config.json` by design, so a leftover `export DENIED_URL=...` sends every check to the wrong address; under the default `failMode: open` the gate then allows everything while looking installed. Unset it, or launch `agy` from a clean shell. |

## Uninstalling

```bash
./uninstall.sh
```

It takes the same `--scope`, `--workspace`, `--node` and `--dry-run` flags as the installer, and removes only the `denied-authz` group from the hook files it installed — other hook groups are left intact — and deletes the staged interceptor. `~/.denied/config.json` is left alone in case you still want the API key. Restart any running `agy` session afterwards.

## Links

- [Antigravity hooks documentation](https://antigravity.google/docs/hooks) — the platform's hook contract
- [Denied](https://denied.dev) — Define the boundaries of AI agents
- [Denied Dashboard](https://app.denied.dev) — Manage policies and API keys
