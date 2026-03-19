# Denied SDK Plugin for OpenClaw

AI agents in OpenClaw can execute powerful tools, shell commands, file operations, API calls, and more. [Denied](https://denied.dev) defines the boundaries of what your agents can and cannot do: before any tool executes, this plugin checks with the Denied authorization server whether the agent is permitted to run it. If the policy says no, the tool call is blocked and the reason is returned to the agent. You define the boundaries; the plugin enforces them.

## Prerequisites

- A running [OpenClaw](https://openclaw.ai) gateway (local or Docker)
- A Denied account and API key. Sign up at [app.denied.dev](https://app.denied.dev)

## Quickstart (Local)

### Step 1: Install the plugin

```bash
openclaw plugins install @denied-dev/denied-openclaw-plugin
```

### Step 2: Configure the plugin

Set your API key as an environment variable, this is the simplest way:

```bash
export DENIED_API_KEY="your-api-key"
```

Alternatively, add the config directly in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "denied-openclaw-plugin": {
        "enabled": true,
        "config": {
          "deniedApiKey": "your-api-key"
        }
      }
    }
  }
}
```

### Step 3: Restart the gateway

```bash
openclaw gateway restart
```

### Step 4: Verify it's working

```bash
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep denied-dev
```

When working correctly, you'll see lines like:

```
[plugin:denied-dev] Blocked tool call: exec
[plugin:denied-dev] Blocked tool call: read
```

## Quickstart (Docker)

### Step 1: Install the plugin

```bash
docker compose run --rm \
  -e OPENCLAW_GATEWAY_URL=ws://openclaw-gateway:18789 \
  openclaw-cli plugins install @denied-dev/denied-openclaw-plugin
```

### Step 2: Configure the plugin

Set your API key as an environment variable in `docker-compose.yml`. This is the simplest way:

```yaml
openclaw-gateway:
  environment:
    DENIED_API_KEY: "your-api-key"
```

Alternatively, add the config directly in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "denied-openclaw-plugin": {
        "enabled": true,
        "config": {
          "deniedApiKey": "your-api-key"
        }
      }
    }
  }
}
```

### Step 3: Restart the gateway

```bash
docker compose restart openclaw-gateway
```

### Step 4: Verify it's working

```bash
docker compose logs -f openclaw-gateway 2>&1 | grep denied-dev
```

When working correctly, you'll see lines like:

```
[plugin:denied-dev] Blocked tool call: exec
[plugin:denied-dev] Blocked tool call: read
```

## Configuration reference

| Config key     | Environment variable | Default                  | Description                                       |
| -------------- | -------------------- | ------------------------ | ------------------------------------------------- |
| `deniedApiKey` | `DENIED_API_KEY`     | —                        | Required. API key for the Denied PDP.             |
| `deniedUrl`    | `DENIED_URL`         | `https://api.denied.dev` | PDP endpoint. Only change for custom deployments. |
| `failMode`     | `DENIED_FAIL_MODE`   | `open`                   | `open` = allow when PDP errors, `closed` = deny.  |
| `timeout`      | `DENIED_TIMEOUT_MS`  | `15000`                  | Timeout in milliseconds.                          |

## Default behavior

**Default-deny**: With no policies configured, every tool call is blocked. This is intentional, you must explicitly define the boundaries for your agent by creating policies in the [Denied dashboard](https://app.denied.dev).

**Fail-open on error**: If the Denied server is unreachable (network issue, server down) or fails, tool calls are allowed through by default. This prevents the plugin from completely breaking the agent. Set `failMode` to `closed` (or `DENIED_FAIL_MODE=closed`) for stricter enforcement. You'll see log entries like:

```
[plugin:denied-dev] Failed: HTTP 503: "no healthy upstream"
```

## How it works

For each tool call, the plugin sends an authorization check to the Denied server:

- **Subject**: `openclaw://<agentId>` with the session key as a property
- **Action**: `execute`
- **Resource**: `tool://<toolName>` with the tool parameters as properties

The Denied server evaluates the request against your policies and returns allow or deny. If denied, the block reason is surfaced to the agent so it can adapt its behavior.

## Creating policies

After installing the plugin, all tool calls are blocked by default. You need to create policies to define what your agent is allowed to do.

Every blocked tool call is logged as an authorization decision in the [Denied dashboard](https://app.denied.dev). These decision logs capture the full context of each request the agent identity, the tool name, and the parameters (command, file path, etc.).

The Denied dashboard includes an AI policy generator that can read these decision logs and produce least-privilege policies for you. For example, from a blocked `tool://read` and `tool://exec` log, the generator can produce policies that:

- Allow only read-only commands (`ls`, `cat`, `head`, `tail`, `find`) for `tool://exec`
- Scope `tool://read` access to specific directory paths
- Constrain policies to a specific agent or session

This means you can start with default-deny, let the agent run into the boundaries, then review the decision logs in the dashboard and use the AI policy generator to create precise allow rules without writing Rego from scratch.

## Troubleshooting

| Log message                               | Meaning                              | Fix                                                                                                                            |
| ----------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `Blocked tool call: <name>`               | Policy denied the tool call          | Working as intended. Create an allow policy in the [Denied dashboard](https://app.denied.dev) if the tool should be permitted. |
| `Failed: HTTP 503: "no healthy upstream"` | Plugin can't reach the Denied server | Check `deniedUrl` is correct. For Docker, ensure the container can reach external networks.                                    |
| `Failed: HTTP 401` or `403`               | Invalid or missing API key           | Check `DENIED_API_KEY` env var or `deniedApiKey` in config.                                                                    |
| `Failed: fetch failed`                    | Network connectivity issue           | Check DNS resolution and firewall rules. Docker containers may need specific network config to reach external services.        |
| No `[plugin:denied-dev]` lines at all     | Plugin not loaded                    | Check that `plugins.entries.denied-openclaw-plugin.enabled` is `true` in config and restart the gateway.                       |

## Links

- [OpenClaw](https://openclaw.ai) [Plugin docs](https://docs.openclaw.ai/tools/plugin)
- [Denied](https://denied.dev) Define the boundaries of AI agents
- [Denied Dashboard](https://app.denied.dev) Manage policies and API keys
