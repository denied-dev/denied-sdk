# Denied SDK

Official SDKs for the [Denied][denied-website] authorization platform.

Make permission checks with a simple API that follows Authzen Authorization API standard.

## Available SDKs

- **[Python](./python/README.md)**: sync and async client with Pydantic validation
- **[TypeScript](./typescript/README.md)**: promise-based client with full type definitions

## Available Extensions

Denied integrations are available for **[Claude Code](./extensions/claude-code/README.md)**, **[Codex CLI](./extensions/codex/README.md)**, **[Hermes Agent](./extensions/hermes/README.md)**, and **[OpenClaw](./extensions/openclaw/README.md)**. Each integration hooks into tool execution and checks authorization before a tool call runs.

## Development

Run extension tests from the repository root:

```bash
uv run --package denied-hermes-plugin pytest extensions/hermes/tests
uv run --package denied-hermes-plugin ruff check extensions/hermes
uv run --package denied-hermes-plugin ruff format --check extensions/hermes
```

## License

Apache-2.0

[denied-website]: https://denied.dev
