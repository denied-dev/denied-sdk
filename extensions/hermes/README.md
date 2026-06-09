# Denied SDK Hook for Hermes Agent

Hermes Agent can execute shell commands, file operations, web requests, plugin tools, and other capabilities. [Denied](https://denied.dev) defines the boundaries of what Hermes may do: before every tool executes, this hook checks with the Denied authorization server whether the tool call is permitted. If the policy says no, the tool call is blocked and the denial reason is returned to Hermes.

This MVP is implemented as a Hermes shell hook. It is a single zero-dependency Node.js script that reads Hermes hook payloads from stdin, sends a Denied `/pdp/check` request, and writes the Hermes hook decision to stdout.

## Prerequisites

- A running Hermes Agent gateway or CLI
- Node.js 18+ available where Hermes executes shell hooks
- A Denied account and API key. Sign up at [app.denied.dev](https://app.denied.dev)

## Quickstart

### Step 1: Install the hook script

Copy `denied-hermes-hook.js` into your Hermes data directory:

```bash
mkdir -p ~/.hermes/agent-hooks
cp denied-hermes-hook.js ~/.hermes/agent-hooks/denied-hermes-hook.js
chmod +x ~/.hermes/agent-hooks/denied-hermes-hook.js
```

For Docker deployments using the upstream Hermes layout, `~/.hermes` on the host is mounted into the container as `/opt/data`.

### Step 2: Configure Denied

Create `~/.hermes/denied.json`:

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
    "dir": "~/.hermes/denied-audit",
    "includeRawPayload": true,
    "includeMappedRequest": true,
    "includeDecision": true
  }
}
```

Set the API key as an environment variable:

```bash
export DENIED_API_KEY="your-api-key"
```

Environment variables override values in `denied.json`:

| Config key         | Environment variable     | Default                  | Description                                      |
| ------------------ | ------------------------ | ------------------------ | ------------------------------------------------ |
| `url`              | `DENIED_URL`             | `https://api.denied.dev` | PDP endpoint.                                    |
| `apiKey`           | `DENIED_API_KEY`         | -                        | API key for the Denied PDP.                      |
| `failMode`         | `DENIED_FAIL_MODE`       | `open`                   | `open` = allow on PDP errors, `closed` = block.  |
| `timeoutMs`        | `DENIED_TIMEOUT_MS`      | `15000`                  | PDP timeout in milliseconds.                     |
| `useSemanticMapping` | -                      | `true`                   | Map common tools to file, command, URL, etc.     |
| `subjectId`        | -                        | `session`                | `session`, `task`, or `tool_call`.               |
| `request.includeHookPayload` | -               | `true`                   | Include the original Hermes hook payload in Denied `context.hook_payload`. |
| `request.includeToolInput` | -                 | `true`                   | Include raw tool input in the authorization request. |
| `request.maxContextBytes` | -                  | `20000`                  | Maximum JSON bytes for raw payload context before truncation. |
| `redaction.enabled` | -                       | `true`                   | Redact sensitive fields before sending requests or writing audit logs. |
| `redaction.keys`   | -                        | common secret key names  | Case-insensitive partial key matches to redact recursively. |
| `audit.enabled`    | -                        | `false`                  | Write local JSONL audit records for raw payload, mapped request, and decision. |

You can also point the hook at a different config file:

```bash
export DENIED_CONFIG="/path/to/denied.json"
```

### Step 3: Register the Hermes hook

Add this to `~/.hermes/config.yaml`:

```yaml
hooks:
  pre_tool_call:
    - matcher: ".*"
      command: "node /opt/data/agent-hooks/denied-hermes-hook.js"
      timeout: 15

hooks_auto_accept: true
```

For non-Docker local Hermes, this command may be more convenient:

```yaml
hooks:
  pre_tool_call:
    - matcher: ".*"
      command: "node ~/.hermes/agent-hooks/denied-hermes-hook.js"
      timeout: 15
```

### Step 4: Docker environment

For Docker, pass the Denied environment variables to the Hermes container:

```yaml
services:
  hermes:
    environment:
      - HERMES_DASHBOARD=1
      - HERMES_ACCEPT_HOOKS=1
      - DENIED_API_KEY=your-api-key
      - DENIED_URL=https://api.denied.dev
      - DENIED_FAIL_MODE=open
      - DENIED_TIMEOUT_MS=15000
```

Restart Hermes after changing hook configuration:

```bash
docker compose restart hermes
```

## How It Works

Hermes sends a JSON payload to the hook before every tool call:

```json
{
  "hook_event_name": "pre_tool_call",
  "tool_name": "terminal",
  "tool_input": { "command": "ls -la" },
  "session_id": "sess_abc123",
  "cwd": "/workspace/project",
  "extra": {
    "task_id": "...",
    "tool_call_id": "..."
  }
}
```

The hook maps it to a Denied authorization request:

```json
{
  "subject": {
    "type": "hermes-agent",
    "id": "sess_abc123",
    "properties": {
      "runtime": "hermes-agent",
      "session_id": "sess_abc123",
      "task_id": "...",
      "cwd": "/workspace/project"
    }
  },
  "action": {
    "name": "run_command",
    "properties": {
      "effect": "read",
      "tool_name": "terminal",
      "capability": "shell.command"
    }
  },
  "resource": {
    "type": "command",
    "id": "ls",
    "properties": {
      "command": "ls -la",
      "tool_name": "terminal",
      "tool_call_id": "...",
      "raw_tool": {
        "name": "terminal",
        "input": { "command": "ls -la" }
      }
    }
  },
  "context": {
    "integration": "denied-hermes-shell-hook",
    "hook_event_name": "pre_tool_call",
    "authz_direction": "agent-to-world",
    "hook_payload": {
      "hook_event_name": "pre_tool_call",
      "tool_name": "terminal",
      "tool_input": { "command": "ls -la" },
      "session_id": "sess_abc123",
      "cwd": "/workspace/project",
      "extra": {
        "task_id": "...",
        "tool_call_id": "..."
      }
    }
  }
}
```

Denied returns:

```json
{
  "decision": false,
  "context": {
    "reason": "Shell deletes are not allowed in this workspace."
  }
}
```

If denied, the hook blocks the Hermes tool call:

```json
{
  "action": "block",
  "message": "Shell deletes are not allowed in this workspace."
}
```

If allowed, the hook returns the allow reason as non-blocking JSON:

```json
{
  "reason": "Read-only shell commands are allowed.",
  "message": "Read-only shell commands are allowed."
}
```

Hermes only uses `pre_tool_call` output to block a call; non-blocking fields are ignored by the model path. Deny reasons are returned to the agent as the blocked tool error. Allow reasons are still emitted by the hook and visible through hook testing/logging, without modifying successful tool results.

## Semantic Mapping

The hook always includes the raw Hermes tool name. When `request.includeToolInput` is enabled, it also includes the raw tool input. `action.name` represents the agent behavior or tool-level operation, while `action.properties.effect` carries the normalized low-level effect (`read`, `create`, `update`, `delete`, or `execute`). When `useSemanticMapping` is enabled, the hook also maps common tool calls into more policy-friendly resources:

| Hermes tool shape              | Action name                              | Effect inference              | Resource mapping              |
| ------------------------------ | ---------------------------------------- | ----------------------------- | ----------------------------- |
| `terminal` with `command`      | `run_command`                            | shell command patterns        | `command://<argv0>`           |
| `search_files`                 | `search_files`                           | `read`                        | `file://<resolved path>`      |
| tools with `path`/`file_path`  | normalized tool name                     | by tool name                  | `file://<resolved path>`      |
| tools with `url`/`uri`         | normalized tool name or `http_<method>`  | by tool name                  | `url://<url>`                 |
| `web_search` / `websearch`     | `web_search`                             | `read`                        | `web-search://default`        |
| unknown tools                  | normalized tool name                     | `execute`                     | `tool://<tool_name>`          |

For shell commands, simple command pattern matching is used:

- `ls`, `cat`, `grep`, `find`, `pwd`, `date`, etc. -> `read`
- `cp`, `mv`, `mkdir`, `touch`, redirection, `tee`, etc. -> `create`
- `sed -i`, `chmod`, `chown`, etc. -> `update`
- `rm`, `rmdir`, `unlink` -> `delete`
- unknown commands -> `execute`

## Raw Payload Context and Audit

For observability, the hook includes the original Hermes hook payload in `request.context.hook_payload` by default. This keeps Denied decision logs useful even when the semantic mapper is imperfect or too conservative.

Sensitive fields are redacted recursively before raw payload or raw tool input is sent to Denied or written to local audit logs. Redaction is based on case-insensitive partial key matching. For example, with the default `redaction.keys`, fields such as `token`, `github_token`, `apiKey`, `api_key`, `Authorization`, and `client_secret` are replaced with `[REDACTED]`.

Large raw payloads are truncated after `request.maxContextBytes` JSON bytes:

```json
{
  "truncated": true,
  "max_bytes": 20000,
  "original_bytes": 43122,
  "preview": "{...}"
}
```

Local audit logging can be enabled for deeper mapper analysis:

```json
{
  "audit": {
    "enabled": true,
    "dir": "~/.hermes/denied-audit",
    "includeRawPayload": true,
    "includeMappedRequest": true,
    "includeDecision": true
  }
}
```

Audit records are appended as JSONL to:

```text
~/.hermes/denied-audit/denied-hermes-hook.jsonl
```

Audit output is also controlled by `redaction.enabled` and `redaction.keys`.

## Failure Mode

By default, the hook is fail-open: if Denied is unreachable or returns an unexpected response, Hermes is allowed to continue. Set `DENIED_FAIL_MODE=closed` or `"failMode": "closed"` for strict enforcement.

When fail-closed, PDP errors block the tool call and return the error reason to Hermes.

## Troubleshooting

| Symptom                              | Meaning                                      | Fix                                                |
| ------------------------------------ | -------------------------------------------- | -------------------------------------------------- |
| Tool calls always allowed            | Hook not registered or fail-open on errors   | Check `~/.hermes/config.yaml` and Hermes logs.     |
| `DENIED_API_KEY/apiKey is not set`   | No API key configured                        | Set `DENIED_API_KEY` or `apiKey` in `denied.json`. |
| `HTTP 401` or `HTTP 403`             | Invalid API key                              | Check the configured API key.                      |
| `fetch failed`                       | Container cannot reach Denied                | Check Docker networking and `DENIED_URL`.          |
| Hook is not loaded in gateway/CI      | Hook consent missing in non-TTY runtime      | Use `HERMES_ACCEPT_HOOKS=1` or `hooks_auto_accept`. |

## Links

- [Hermes Agent](https://hermes-agent.nousresearch.com)
- [Hermes Event Hooks](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md)
- [Denied](https://denied.dev)
- [Denied Dashboard](https://app.denied.dev)
