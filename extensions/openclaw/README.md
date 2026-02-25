# Denied SDK Hook Plugin for OpenClaw

An [OpenClaw][openclaw-website] plugin that enforces authorization on every tool call using the Denied policy engine.

Before any tool executes, the plugin checks with your Denied server whether the agent is permitted to run it. If the check fails, the tool call is blocked and the reason is returned to the agent.

## Installation

```bash
openclaw plugins install denied-sdk-openclaw
```

Then restart the Gateway.

## Configuration

Add to your OpenClaw config under `plugins.entries.denied-sdk-openclaw.config`:

```json
{
  "plugins": {
    "entries": {
      "denied-sdk-openclaw": {
        "enabled": true,
        "config": {
          "deniedUrl": "https://example.denied.dev", // optional, defaults to DENIED_URL env var or "https://api.denied.dev" if unset
          "deniedApiKey": "your-api-key" // optional, defaults to DENIED_API_KEY env var
        }
      }
    }
  }
}
```

## How it works

For each tool call, the plugin sends an authorization check request to Denied:

- **Subject**: `openclaw://<agentId>` with the session key as a property
- **Action**: `execute`
- **Resource**: `tool://<toolName>` with the tool parameters as properties

If the decision is `false`, the tool call is blocked and the reason from the Denied response is surfaced. If the Denied server is unreachable, the tool call proceeds (fail-open).

## Requirements

- [OpenClaw with plugins][openclaw-plugin-docs]
- A running Denied decision node

[openclaw-website]: https://openclaw.ai
[openclaw-plugin-docs]: https://docs.openclaw.ai/tools/plugin
