# Denied Authorization for Claude Agent SDK

Frictionless authorization layer for Claude agents. Intercepts tool calls and enforces policies via Denied's authorization service.

## Quick Start

**1. Install:**
```bash
pip install "denied-sdk[claude-sdk]"
# or with uv
uv add "denied-sdk[claude-sdk]"
```

**2. Add to your agent:**
```python
from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
from denied_sdk.integrations.claude_sdk import create_denied_permission_callback

permission_callback = create_denied_permission_callback(
    user_id="alice",
    principal_attributes={"role": "user"},
)

options = ClaudeAgentOptions(
    can_use_tool=permission_callback,  # <- Add this line
)

async with ClaudeSDKClient(options) as client:
    await client.query("List files in the current directory")
    async for message in client.receive_response():
        print(message)
```

**3. Set environment variables:**
```bash
export DENIED_URL="https://app.denied.dev/pdp/123"
export DENIED_API_KEY="your-api-key"
```

That's it. All tool calls now require authorization.

## How It Works

```
User Request -> Claude -> can_use_tool callback
                              |
                         Denied PDP (/check API)
                              |
                         Allow/Deny -> Tool Execution (or Denied)
```

The callback extracts context and sends to Denied:
- **Principal**: `user_id`, `session_id`, `role` (from callback args)
- **Resource**: `tool_name`, `tool_input` (from tool call)
- **Action**: Inferred from tool name (`Read` -> read, `Write` -> create, etc.)

## Configuration

```python
from denied_sdk.integrations.claude_sdk import AuthorizationConfig, create_denied_permission_callback

config = AuthorizationConfig(
    denied_url="https://app.denied.dev/pdp/123",
    denied_api_key="your-key",
    fail_mode="closed",     # or "open" - behavior when Denied is unavailable
    retry_attempts=2,
    timeout_seconds=5.0,
    extract_tool_args=True, # include tool arguments in resource attributes
)

permission_callback = create_denied_permission_callback(
    config=config,
    user_id="alice",
    principal_attributes={"role": "user"},
    resource_attributes={"scope": "user"},
)
```

## Policy Example

Create this policy in your Denied dashboard:

```rego
# Allow users to read user-scoped resources
allow {
    input.principal.attributes.role == "user"
    input.resource.attributes.scope == "user"
    input.action == "read"
}

# Allow admins to do anything
allow {
    input.resource.attributes.scope == "admin"
}
```

Pass attributes when creating the callback:
```python
permission_callback = create_denied_permission_callback(
    user_id="alice",
    principal_attributes={"role": "user"},   # -> input.principal.attributes.role
    resource_attributes={"scope": "user"},   # -> input.resource.attributes.scope
)
```

## Examples

- **Built-in Tools**: `examples/claude_agent_sdk/claude_sdk_auth.py` - Authorize Claude Code's built-in tools (Read, Write, Edit, Bash, etc.)
- **MCP Tools**: `examples/claude_agent_sdk/mcp_server_auth.py` - Authorize custom MCP server tools

## Action Inference

Tool names are mapped to actions:

**Claude Code Built-in Tools:**
- `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch` -> **read**
- `Write` -> **create**
- `Edit`, `MultiEdit`, `NotebookEdit` -> **update**
- `Bash`, `Task`, `TodoWrite`, `KillShell` -> **execute**

**MCP Tool Patterns:**
- `list_*`, `get_*`, `search_*`, `read_*` -> **read**
- `create_*`, `post_*`, `send_*`, `write_*` -> **create**
- `update_*`, `patch_*`, `rename_*`, `edit_*` -> **update**
- `delete_*`, `remove_*` -> **delete**
- Others -> **execute**

## Fail Modes

- **`fail_mode="closed"`** (default): Deny access if Denied service is unavailable
- **`fail_mode="open"`**: Allow access if Denied service is unavailable

## Testing

```bash
cd python
uv run pytest tests/integrations/claude_sdk/
```

## Requirements

- Python 3.10+
- `claude-agent-sdk>=0.1.0`
- `denied-sdk>=0.1.0`
