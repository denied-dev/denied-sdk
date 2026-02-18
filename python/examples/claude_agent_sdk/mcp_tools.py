"""Denied authorization callback with custom MCP server tools.

This example shows authorization on CUSTOM MCP TOOLS (not just built-in tools).
We define a simple "project" MCP server with read_project, delete_project, and
create_project tools. The Denied callback intercepts these custom tool calls.

Two scenarios test the same user reading projects with different resource scopes:
- User scope: can read (allowed)
- Admin scope: blocked from reading (denied)

How it works:
1. User sends message: "Get details for project prj-123"
2. Claude sees our custom MCP tool `mcp__projects__read_project`
3. SDK calls our permission callback with: tool_name="mcp__projects__read_project"
4. Callback maps tool name → action="read", sends check to Denied
5. Denied evaluates policy → ALLOW or DENY based on scope
6. Callback returns PermissionResultAllow or PermissionResultDeny
7. Claude proceeds or receives denial

Policy Rules (in Denied):
- Allow: subject.properties.role='user' AND resource.properties.scope='user' AND action.name='read'

Setup:
1. Install: pip install denied-sdk[claude-sdk]
2. Set env vars:
   export ANTHROPIC_API_KEY='your-key'
   export DENIED_API_KEY='your-key'
3. Run: python examples/claude_agent_sdk/mcp_server_auth.py
"""

import asyncio
import os
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    TextBlock,
    create_sdk_mcp_server,
    tool,
)

from denied_sdk.integrations.claude_sdk import (
    AuthorizationConfig,
    create_denied_permission_callback,
)

# =============================================================================
# Custom MCP Tools - These are the tools we're protecting with Denied
# =============================================================================


@tool("read_project", "Read project details by ID", {"project_id": str})
async def read_project(args: dict[str, Any]) -> dict[str, Any]:
    """Read project data. This is a read operation."""
    project_id = args["project_id"]
    # Mock project data
    return {
        "content": [
            {
                "type": "text",
                "text": f"Project {project_id}: name='My Project', status='active', owner='alice'",
            }
        ]
    }


@tool("delete_project", "Delete a project by ID", {"project_id": str})
async def delete_project(args: dict[str, Any]) -> dict[str, Any]:
    """Delete a project. This is a delete operation - requires admin."""
    project_id = args["project_id"]
    return {
        "content": [
            {
                "type": "text",
                "text": f"Project {project_id} has been deleted.",
            }
        ]
    }


@tool("create_project", "Create a new project", {"name": str, "description": str})
async def create_project(args: dict[str, Any]) -> dict[str, Any]:
    """Create a new project. This is a create operation."""
    return {
        "content": [
            {
                "type": "text",
                "text": f"Created project '{args['name']}' with ID prj-new-123",
            }
        ]
    }


# =============================================================================
# Demo scenarios
# =============================================================================


async def run_scenario(
    name: str,
    user_id: str,
    role: str,
    scope: str,
    message: str,
    projects_server,
):
    """Run a single authorization scenario."""
    print(f"\n{'=' * 60}")
    print(f"Scenario: {name}")
    print(f"User: {user_id} (role={role}, scope={scope})")
    print(f"Message: {message}")
    print("-" * 60)

    config = AuthorizationConfig(
        denied_url=os.getenv("DENIED_URL"),
        denied_api_key=os.getenv("DENIED_API_KEY"),
        fail_mode="closed",
        timeout_seconds=15.0,  # Allow for cold starts
    )

    # Permission callback intercepts ALL tool calls including our custom MCP tools
    # Tool names will be like: mcp__projects__read_project, mcp__projects__delete_project
    # Pass subject_properties with role and resource_properties with scope for policy matching
    permission_callback = create_denied_permission_callback(
        config=config,
        user_id=user_id,
        subject_properties={"role": role},
        resource_properties={"scope": scope},
    )

    # IMPORTANT: Do NOT use allowed_tools here!
    # allowed_tools auto-approves tools without going through the permission callback.
    # We want all tool calls to go through our Denied authorization callback.
    options = ClaudeAgentOptions(
        model="claude-3-5-haiku-20241022",  # Cheapest model
        mcp_servers={"projects": projects_server},
        can_use_tool=permission_callback,
    )

    try:
        async with ClaudeSDKClient(options) as client:
            await client.query(message)

            async for msg in client.receive_response():
                if isinstance(msg, AssistantMessage):
                    for block in msg.content:
                        if isinstance(block, TextBlock) and block.text.strip():
                            print(f"\n💬 Claude: {block.text[:500]}")

                elif isinstance(msg, ResultMessage):
                    print(f"\n✓ Done ({msg.duration_ms}ms)")

    except Exception as e:
        print(f"\n❌ Error: {e}")


async def main():
    """Run the MCP authorization demo."""
    print("=" * 60)
    print("Claude Agent SDK + Denied + Custom MCP Tools")
    print("=" * 60)
    print("\nThis demo shows authorization on CUSTOM MCP TOOLS:")
    print("- read_project → action='read'")
    print("\nTwo scenarios with different resource scopes:")
    print("- scope='user' → ALLOW")
    print("- scope='admin' → DENY")

    # Create our custom MCP server with project tools
    projects_server = create_sdk_mcp_server(
        name="projects",
        version="1.0.0",
        tools=[read_project, delete_project, create_project],
    )

    # Scenario 1: User reads user-scoped project (should ALLOW)
    await run_scenario(
        name="User reads user-scoped project (read → ALLOW)",
        user_id="alice",
        role="user",
        scope="user",
        message="Get details for project prj-123",
        projects_server=projects_server,
    )

    # Scenario 2: User reads admin-scoped project (should DENY)
    await run_scenario(
        name="User reads admin-scoped project (read → DENY)",
        user_id="alice",
        role="user",
        scope="admin",
        message="Get details for project prj-456",
        projects_server=projects_server,
    )

    print("\n" + "=" * 60)
    print("Demo completed!")
    print("=" * 60)


if __name__ == "__main__":
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass

    if not os.getenv("ANTHROPIC_API_KEY"):
        print("❌ ANTHROPIC_API_KEY not set")
        exit(1)

    if not os.getenv("DENIED_URL") and not os.getenv("DENIED_API_KEY"):
        print("DENIED_URL or DENIED_API_KEY not set")
        exit(1)

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nInterrupted")
