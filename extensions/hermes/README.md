# Denied Hermes Plugin

Denied checks Hermes Agent tool calls before they execute. If policy denies a
call, Hermes receives a native block response and the tool does not run.

## Supported Platforms

The installer supports macOS and Linux environments with Bash and standard Unix
tools. On Windows, run it from WSL or install the plugin manually in the Hermes
runtime environment.

## Quick Install

Install from a local clone:

```bash
git clone https://github.com/denied-dev/denied-sdk.git
cd denied-sdk
extensions/hermes/install.sh
```

Install with `curl`:

```bash
curl -fsSL https://raw.githubusercontent.com/denied-dev/denied-sdk/main/extensions/hermes/install.sh | bash
```

The installer uses Hermes' Python virtual environment and `pip`;

Restart Hermes or start a new Hermes session after enabling the plugin.
For non-default Hermes profiles, export `HERMES_HOME` before running the install
commands and before starting Hermes.

Verify that Hermes sees the plugin:

```bash
hermes plugins list | rg denied
```

Expected status:

```text
denied    enabled
```

## Docker Install

If Hermes runs in a container, run the installer inside that container so it
uses the same Python virtual environment as Hermes:

```bash
curl -fsSL https://raw.githubusercontent.com/denied-dev/denied-sdk/main/extensions/hermes/install.sh \
  | docker exec -i hermes bash
```

If the container cannot download from the network, copy a local clone into it:

```bash
git clone https://github.com/denied-dev/denied-sdk.git
docker cp denied-sdk hermes:/tmp/denied-sdk
docker exec hermes bash /tmp/denied-sdk/extensions/hermes/install.sh
```

## Configure

At minimum, provide a Denied API key to the Hermes process:

```bash
export DENIED_API_KEY="your-api-key"
```

Optional environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `DENIED_URL` | `https://api.denied.dev` | Denied PDP base URL. |
| `DENIED_FAIL_MODE` | `open` | `open` allows tool calls on Denied errors; `closed` blocks them. |
| `DENIED_TIMEOUT_MS` | `15000` | Denied request timeout in milliseconds. |
| `DENIED_CONFIG` | - | Path to a JSON config file. |

You can also configure the plugin with `$HERMES_HOME/denied.json`. If
`HERMES_HOME` is not set, Hermes uses the default profile at `~/.hermes`:

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

Environment variables override values in `denied.json`.

Config lookup order:

1. Environment variables.
2. `DENIED_CONFIG`.
3. `$HERMES_HOME/denied.json` (usually `~/.hermes/denied.json`).
4. `/opt/data/denied.json`.
5. Built-in defaults.

## Recommended Fail Mode

Use `closed` when Denied should be a hard enforcement boundary:

```bash
export DENIED_FAIL_MODE="closed"
```

With fail-closed mode, Hermes blocks tool calls if Denied is unavailable or
configuration is invalid. With fail-open mode, Hermes allows tool calls when
Denied cannot be reached.

## Audit Logs

Enable audit records in `$HERMES_HOME/denied.json`:

```json
{
  "audit": {
    "enabled": true,
    "includeRawPayload": true,
    "includeMappedRequest": true,
    "includeDecision": true
  }
}
```

Audit records are written to:

```text
$HERMES_HOME/denied-audit/denied-hermes-hook.jsonl
```

> **Security note:** Audit logs may contain sensitive data. When `audit.enabled` is true, `audit.includeRawPayload`, `audit.includeMappedRequest`, `request.includeToolInput`, and `request.includeHookPayload` default to `true`, so audit records can include full tool inputs, hook payloads, file contents, shell commands, URLs, and credentials. Store audit logs only in a location with appropriate access controls.

## Verify Blocking

To verify fail-closed behavior, point Denied at an unavailable local endpoint:

```bash
export DENIED_API_KEY="test"
export DENIED_URL="http://127.0.0.1:1"
export DENIED_FAIL_MODE="closed"
```

Start a new Hermes session and trigger a tool call. It should be blocked with a
message containing `fail-mode is closed`.

## Troubleshooting

- Plugin not listed: rerun the installer and confirm `HERMES_HOME` points to the
  same profile Hermes uses.
- Tool calls still run when Denied is unavailable: set
  `DENIED_FAIL_MODE=closed` and restart Hermes.
- Config changes not taking effect: restart Hermes or start a new session.
- Container install does not work: run the installer inside the Hermes container,
  not on the host.
