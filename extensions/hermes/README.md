# Denied Hermes Plugin

Denied checks Hermes Agent tool calls before they execute. If policy denies a
call, Hermes receives a native block response and the tool does not run.

## Quick Install

Until the plugin is published as a standalone Hermes plugin repository, install
it from this monorepo by cloning the repo and copying the `extensions/hermes`
plugin directory into Hermes.

```bash
tmp_dir="$(mktemp -d)"
hermes_home="${HERMES_HOME:-$HOME/.hermes}"
git clone --depth 1 https://github.com/denied-dev/denied-sdk.git "$tmp_dir/denied-sdk"

uv pip install --python "$hermes_home/hermes-agent/venv/bin/python" -e "$tmp_dir/denied-sdk/python"
uv pip install --python "$hermes_home/hermes-agent/venv/bin/python" -e "$tmp_dir/denied-sdk/extensions/hermes"

rm -rf "$hermes_home/plugins/denied"
mkdir -p "$hermes_home/plugins/denied/src"
cp "$tmp_dir/denied-sdk/extensions/hermes/__init__.py" \
  "$tmp_dir/denied-sdk/extensions/hermes/plugin.yaml" \
  "$tmp_dir/denied-sdk/extensions/hermes/README.md" \
  "$tmp_dir/denied-sdk/extensions/hermes/pyproject.toml" \
  "$hermes_home/plugins/denied/"
cp -R "$tmp_dir/denied-sdk/extensions/hermes/src/denied_hermes" \
  "$hermes_home/plugins/denied/src/"

hermes plugins enable denied
rm -rf "$tmp_dir"
```

Restart Hermes or start a new Hermes session after enabling the plugin.
For non-default Hermes profiles, export `HERMES_HOME` before running the install
commands and before starting Hermes.

Verify installation:

```bash
hermes plugins list | rg denied
```

Expected status:

```text
denied    enabled
```

## Future Direct Git Install

Hermes can install plugins directly from Git when `plugin.yaml` is at the
repository root:

```bash
hermes plugins install owner/repo --enable
```

When this plugin is published as a dedicated repository, the install command
will be:

```bash
hermes plugins install denied-dev/denied-hermes-plugin --enable
```

The plugin manifest declares `pip_dependencies: ["denied-sdk>=0.5.2"]`, and
the Python package also declares `denied-sdk` as a runtime dependency. The plugin
does not import `denied_sdk` at discovery time; it imports the SDK only when the
authorization hook is constructed or maps a tool call. This follows Hermes'
dependency-loading guidance and avoids disabling plugin discovery just because a
dependency has not been installed yet.

Do not use `hermes plugins install denied-dev/denied-sdk --enable` for the
current monorepo layout. Hermes will clone the repository root, not the
`extensions/hermes` subdirectory.

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

## Smoke Test

Check that Hermes' Python runtime can import the plugin:

```bash
hermes_home="${HERMES_HOME:-$HOME/.hermes}"
PYTHONPATH="$hermes_home/plugins/denied/src" \
  "$hermes_home/hermes-agent/venv/bin/python" -c "from denied_hermes.plugin import DeniedHermesPlugin; p = DeniedHermesPlugin(); print({'url': p.config.url, 'fail_mode': p.config.fail_mode, 'has_api_key': bool(p.config.api_key)}); p.close()"
```

Test fail-closed behavior:

```bash
export DENIED_API_KEY="test"
export DENIED_URL="http://127.0.0.1:1"
export DENIED_FAIL_MODE="closed"
```

Start a new Hermes session and trigger a tool call. It should be blocked with a
message containing `fail-mode is closed`.

## Troubleshooting

- Plugin not listed: confirm files exist under `$HERMES_HOME/plugins/denied` and
  run `hermes plugins enable denied`.
- Import error for `denied_sdk`: install the SDK into Hermes' Python runtime:
  `uv pip install --python "$HERMES_HOME/hermes-agent/venv/bin/python" denied-sdk`.
- Config changes not taking effect: restart Hermes or start a new session.
