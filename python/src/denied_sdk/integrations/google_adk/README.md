# Denied Authorization for Google ADK

Frictionless authorization layer for Google ADK agents. Intercepts tool calls and enforces policies via Denied's authorization service.

## Quick Start

**1. Install:**
```bash
pip install "denied-sdk[adk]"
# or with uv
uv add "denied-sdk[adk]"
```

**2. Add to your agent:**
```python
from google.adk import Agent, Runner
from denied_sdk.integrations.google_adk import AuthorizationPlugin

agent = Agent(name="my_agent", model="gemini-2.5-flash", tools=[...])

runner = Runner(
    agent=agent,
    plugins=[AuthorizationPlugin()],  # ← Add this line
)
```

**3. Set environment variables:**
```bash
export DENIED_URL="https://your-pdp.denied.com"
export DENIED_API_KEY="your-api-key"
```

That's it. All tool calls now require authorization.

## How It Works

```
User Request → Agent → AuthorizationPlugin.before_tool_callback()
                       ↓
                   Denied PDP (/check API)
                       ↓
                   Allow/Deny → Tool Execution (or Denied)
```

The plugin extracts context and sends to Denied:
- **Principal**: `user_id`, `agent_name`, `session_id`, `role` (from session state)
- **Resource**: `tool_name`, `tool_description`, `tool_input_schema`, tool args, `scope` (from session state)
- **Action**: Inferred from tool name (`list_*` → read, `create_*` → create, etc.)

## Configuration

```python
from denied_sdk.integrations.google_adk import AuthorizationConfig, AuthorizationPlugin

config = AuthorizationConfig(
    denied_url="https://your-pdp.com",
    denied_api_key="your-key",
    fail_mode="closed",  # or "open" - behavior when Denied is unavailable
    retry_attempts=2,
    timeout_seconds=5.0,
)

plugin = AuthorizationPlugin(config)
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
```

Set scope in session state:
```python
session = await session_service.create_session(
    app_name="my_app",
    user_id="alice",
    state={"role": "user", "resource_scope": "user"},
)
```

## Examples

- **MCP Integration**: `examples/adk_mcp_cospec_example.py` - Real MCP server with diverse tools
- **Basic Usage**: `examples/adk_plugin_example_usage.py` - Scope-based authorization

## Action Inference

Tool names are mapped to actions:
- `list_*`, `get_*`, `search_*` → **read**
- `create_*`, `post_*`, `send_*` → **create**
- `update_*`, `patch_*`, `rename_*` → **update**
- `delete_*`, `remove_*` → **delete**
- Others → **execute**

Supports 277+ real MCP tool patterns (GitHub, Jira, Slack, Notion, etc.)

## Context Extraction

Customize what's sent to Denied:

```python
config = AuthorizationConfig(
    include_user_id=True,      # Principal attribute
    include_agent_name=True,   # Principal attribute
    include_session_id=True,   # Principal attribute
    extract_tool_args=True,    # Resource attributes (file_path, resource_id, etc.)
)
```

The plugin automatically extracts the **tool input schema** for all tools (both MCP tools and FunctionTools) and sends it as `tool_input_schema` in resource attributes. This allows you to write policies based on the structure and types of tool parameters.

## Fail Modes

- **`fail_mode="closed"`** (default): Deny access if Denied service is unavailable
- **`fail_mode="open"`**: Allow access if Denied service is unavailable

## Testing

```bash
cd python
uv run pytest tests/integrations/google_adk/
```

## Requirements

- Python 3.10+
- `google-adk>=0.1.0`
- `denied-sdk>=0.1.0`
