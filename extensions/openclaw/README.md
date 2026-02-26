# Denied SDK Plugin for OpenClaw

AI agents in OpenClaw can execute powerful tools — shell commands, file operations, API calls, and more. [Denied](https://denied.dev) defines the boundaries of what your agents can and cannot do: before any tool executes, this plugin checks with the Denied authorization server whether the agent is permitted to run it. If the policy says no, the tool call is blocked and the reason is returned to the agent. You define the boundaries; the plugin enforces them.

## Prerequisites

- A running [OpenClaw](https://openclaw.ai) gateway (local or Docker)
- A Denied account and API key — sign up at [app.denied.dev](https://app.denied.dev)

## Quickstart

### Step 1: Install the plugin

```bash
openclaw plugins install denied-sdk-openclaw
```

For Docker deployments, run the install via the CLI container:

```bash
docker compose run --rm \
  -e OPENCLAW_GATEWAY_URL=ws://openclaw-gateway:18789 \
  openclaw-cli plugins install denied-sdk-openclaw
```

### Step 2: Configure the plugin

Open your OpenClaw config file at `~/.openclaw/openclaw.json` and add the `config` block under the plugin entry. If the plugin entry was auto-created during install, just add the `config` key:

```json
{
  "plugins": {
    "entries": {
      "denied-sdk-openclaw": {
        "enabled": true,
        "config": {
          "deniedApiKey": "your-api-key"
        }
      }
    }
  }
}
```

The `deniedUrl` defaults to `https://api.denied.dev` and does not need to be set unless you are running a custom deployment.

| Config key | Environment variable | Default |
|---|---|---|
| `deniedUrl` | `DENIED_URL` | `https://api.denied.dev` |
| `deniedApiKey` | `DENIED_API_KEY` | — |

For Docker deployments, you can set environment variables in `docker-compose.yml` instead of editing the config file:

```yaml
openclaw-gateway:
  environment:
    DENIED_API_KEY: "your-api-key"
```

### Step 3: Restart the gateway

The gateway auto-restarts when it detects config changes. If it doesn't, restart manually:

**Local:**

```bash
openclaw gateway restart
```

**Docker:**

```bash
docker compose restart openclaw-gateway
```

### Step 4: Verify it's working

Check the gateway logs for `[plugin:denied-dev]` entries:

**Local:**

```bash
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep denied-dev
```

**Docker:**

```bash
docker compose logs -f openclaw-gateway 2>&1 | grep denied-dev
```

When working correctly, you'll see lines like:

```
[plugin:denied-dev] Blocked tool call: exec
[plugin:denied-dev] Blocked tool call: read
```

## Default behavior

**Default-deny**: With no policies configured, every tool call is blocked. This is intentional — you must explicitly define the boundaries for your agent by creating policies in the [Denied dashboard](https://app.denied.dev).

**Fail-open on error**: If the Denied server is unreachable (network issue, server down), tool calls are allowed through. This prevents the plugin from completely breaking the agent. You'll see log entries like:

```
[plugin:denied-dev] Failed: HTTP 503: "no healthy upstream"
```

## How it works

For each tool call, the plugin sends an authorization check to the Denied server:

- **Subject**: `openclaw://<agentId>` with the session key as a property
- **Action**: `execute`
- **Resource**: `tool://<toolName>` with the tool parameters as properties

The Denied server evaluates the request against your policies and returns allow or deny. If denied, the block reason is surfaced to the agent so it can adapt its behavior.

## Troubleshooting

| Log message | Meaning | Fix |
|---|---|---|
| `Blocked tool call: <name>` | Policy denied the tool call | Working as intended. Create an allow policy in the [Denied dashboard](https://app.denied.dev) if the tool should be permitted. |
| `Failed: HTTP 503: "no healthy upstream"` | Plugin can't reach the Denied server | Check `deniedUrl` is correct. For Docker, ensure the container can reach external networks. |
| `Failed: HTTP 401` or `403` | Invalid or missing API key | Check `deniedApiKey` in config or `DENIED_API_KEY` env var. |
| `Failed: fetch failed` | Network connectivity issue | Check DNS resolution and firewall rules. Docker containers may need specific network config to reach external services. |
| No `[plugin:denied-dev]` lines at all | Plugin not loaded | Check that `plugins.entries.denied-sdk-openclaw.enabled` is `true` in config and restart the gateway. |

## Links

- [OpenClaw](https://openclaw.ai) — [Plugin docs](https://docs.openclaw.ai/tools/plugin)
- [Denied](https://denied.dev) — Define the boundaries of AI agents
- [Denied Dashboard](https://app.denied.dev) — Manage policies and API keys
