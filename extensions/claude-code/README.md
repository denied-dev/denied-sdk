# Denied SDK Plugin for Claude Code

Claude Code can execute powerful tools — shell commands, file operations, web searches, MCP servers, and more. [Denied](https://denied.dev) defines the boundaries of what your Claude Code can and cannot do: before any tool executes, this plugin checks with the Denied authorization server whether the agent is permitted to run it. If the policy says no, the tool call is blocked and the reason is returned to the agent. You define the boundaries; the plugin enforces them.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and working
- Node.js 18+ (already required by Claude Code)
- A Denied account and API key. Sign up at [app.denied.dev](https://app.denied.dev)

## Quickstart

### Step 1: Add the marketplace

```bash
claude plugin marketplace add denied-dev/denied-sdk
```

### Step 2: Install the plugin

```bash
claude plugin install denied-dev-hook
```

### Step 3: Set your API key

```bash
export DENIED_API_KEY="your-api-key"
```

### Step 4: Restart Claude Code

Start a new Claude Code session. The plugin is now active — every tool call will be checked against your Denied policies.

### Step 5: Verify it's working

When a tool call is blocked, Claude Code will display the denial reason inline. You can also check stderr output for lines like:

```
[denied-dev] Blocked tool call: Bash
[denied-dev] Blocked tool call: Write
```

## Configuration reference

| Environment variable | Default                  | Description                                                       |
| -------------------- | ------------------------ | ----------------------------------------------------------------- |
| `DENIED_API_KEY`     | —                        | Required. API key for the Denied PDP.                             |
| `DENIED_URL`         | `https://api.denied.dev` | PDP endpoint. Only change for custom deployments.                 |
| `DENIED_FAIL_MODE`   | `open`                   | `open` = allow on error, `closed` = deny when PDP is unreachable. |

## Default behavior

**Default-deny**: With no policies configured in Denied, every tool call is blocked. This is intentional — you must explicitly define the boundaries for your agent by creating policies in the [Denied dashboard](https://app.denied.dev).

**Fail-open on error**: If the Denied server is unreachable (network issue, server down) or `DENIED_API_KEY` is not set, tool calls are allowed through. This prevents the plugin from completely breaking the agent. Set `DENIED_FAIL_MODE=closed` for stricter enforcement. You'll see log entries like:

```
[denied-dev] Failed to reach Denied PDP: fetch failed
```

## Authorization enforcement

The plugin enforces Denied authorization checks on every tool call, **regardless of Claude Code's permission mode**.

| Permission mode                                        | Claude Code permissions | Denied authorization |
| ------------------------------------------------------ | ----------------------- | -------------------- |
| `default`, `plan`, `acceptEdits`                       | Normal prompts          | Enforced             |
| `dontAsk`                                              | Auto-approved           | Enforced             |
| `bypassPermissions` (`--dangerously-skip-permissions`) | Skipped                 | Enforced             |

`--dangerously-skip-permissions` bypasses Claude Code's built-in permission prompts, but it does **not** bypass Denied policy checks. This is intentional — Denied enforces organizational boundaries that are orthogonal to local permission delegation.

## How it works

For each tool call, the plugin sends an authorization check to the Denied server:

- **Subject**: `claude-code://<sessionId>` with `cwd` and `permission_mode` as properties
- **Action**: `execute`
- **Resource**: `tool://<toolName>` with `tool_input` and `tool_use_id` as properties

The Denied server evaluates the request against your policies and returns allow or deny. If denied, the block reason is fed back to the agent so it can adapt its behavior.

## Creating policies

After installing the plugin, all tool calls are blocked by default. You need to create policies to define what your agent is allowed to do.

Every blocked tool call is logged as an authorization decision in the [Denied dashboard](https://app.denied.dev). These decision logs capture the full context of each request — the session identity, the tool name, and the parameters (command, file path, etc.).

The Denied dashboard includes an AI policy generator that can read these decision logs and produce least-privilege policies for you. This means you can start with default-deny, let the agent run into the boundaries, then review the decision logs and use the AI policy generator to create precise allow rules.

## Troubleshooting

| Symptom                                   | Meaning                              | Fix                                                                                                                            |
| ----------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `Blocked tool call: <name>`               | Policy denied the tool call          | Working as intended. Create an allow policy in the [Denied dashboard](https://app.denied.dev) if the tool should be permitted. |
| `Failed to reach Denied PDP: ...`         | Plugin can't reach the Denied server | Check `DENIED_URL` is correct and network connectivity.                                                                        |
| `HTTP 401` or `403`                       | Invalid or missing API key           | Check `DENIED_API_KEY` env var.                                                                                                |
| `DENIED_API_KEY is not set`               | No API key configured                | Set the `DENIED_API_KEY` environment variable.                                                                                 |
| No `[denied-dev]` lines, tools run freely | Plugin not loaded                    | Verify the plugin is installed (`claude plugin list`) and restart Claude Code.                                                 |

## Uninstalling

```bash
claude plugin uninstall denied-dev-hook
```

Restart Claude Code after uninstalling. This removes the plugin and its hooks — no manual cleanup needed.

## Links

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — Anthropic's agentic coding tool
- [Denied](https://denied.dev) — Define the boundaries of AI agents
- [Denied Dashboard](https://app.denied.dev) — Manage policies and API keys
