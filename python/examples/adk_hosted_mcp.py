"""Denied authorization plugin with hosted MCP server.

Agent connects to a MCP deployment via HTTPS,
gaining access to GitHub and Jira tools. The Denied plugin enforces
authorization before each tool call. Demo shows read access allowed on Jira
but create access denied on GitHub based on role and resource scope

Rego Policy (create in Denied dashboard):
```rego
# Allow users to read user-scoped resources
allow {
    input.principal.attributes.role == "user"
    input.resource.attributes.scope == "user"
    input.action == "read"
}
```

Setup:
1. Install: pip install denied-sdk[adk] (or: uv add denied-sdk[adk])

2. Set environment variables:
   export GEMINI_API_KEY='your-gemini-key'
   export DENIED_URL='https://your-denied-pdp.com'
   export DENIED_API_KEY='your-denied-api-key'
   export COSPEC_MCP_URL='https://mcp.cospec.ai/mcp?deploymentId=YOUR_DEPLOYMENT_ID'
   export COSPEC_API_KEY='your-cospec-api-key'

3. Run the example:
   python examples/adk_mcp_cospec_example.py
"""

import asyncio
import contextlib
import os

from google.adk import Agent, Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams
from google.genai import types

from denied_sdk.integrations.google_adk import AuthorizationConfig, AuthorizationPlugin


async def main():
    """Run the MCP + authorization demo."""

    cospec_url = os.getenv("COSPEC_MCP_URL")
    cospec_key = os.getenv("COSPEC_API_KEY")

    mcp_toolset = None
    try:
        # Create MCP toolset connected to real Cospec server
        mcp_toolset = McpToolset(
            connection_params=StreamableHTTPConnectionParams(
                url=cospec_url,
                headers={"x-auth-header": cospec_key},
                timeout=10.0,
            )
        )

        # Create agent with MCP tools
        agent = Agent(
            name="mcp_assistant",
            model="gemini-2.5-flash",
            instruction="""You are a helpful assistant with access to MCP tools for GitHub, Jira, Slack, and other services. When asked to perform actions, use the appropriate MCP tools. All tool calls are subject to authorization checks by the Denied service.""",
            tools=[mcp_toolset],
        )

        # Configure authorization plugin
        config = AuthorizationConfig(
            denied_url=os.getenv("DENIED_URL"),
            denied_api_key=os.getenv("DENIED_API_KEY"),
            fail_mode="closed",  # Deny on auth service failure
        )

        # Create runner with authorization plugin
        session_service = InMemorySessionService()
        runner = Runner(
            app_name="hosted_mcp_example",
            agent=agent,
            session_service=session_service,
            plugins=[AuthorizationPlugin(config)],
        )

        # Test scenarios
        scenarios = [
            {
                "name": "Alice's Agent tries to get Jira requirements and create an issue in a GitHub repo. (ALLOW read on Jira, DENY create on GitHub)",
                "user_id": "alice",
                "role": "user",
                "scope": "user",
                "project_id": "prj-default-project",
                "message": "First get issue EUN-113 from Jira. Then create issue on https://github.com/jrnesc/empty with details from Jira. Output info from both platforms afterwards",
            }
        ]

        for i, scenario in enumerate(scenarios, 1):
            print(f"\n{'-' * 70}")
            print(f"Scenario {i}: {scenario['name']}")
            print(f"User: {scenario['user_id']} (role: {scenario['role']})")
            print(f"Resource scope: {scenario['scope']}")
            print(f"Request: {scenario['message']}")
            print(f"{'-' * 70}")

            # Create session with role and resource_scope in state
            session = await session_service.create_session(
                app_name="hosted_mcp_example",
                user_id=scenario["user_id"],
                state={
                    "role": scenario["role"],
                    "resource_scope": scenario["scope"],
                },
            )

            # Run the agent
            try:
                response_text = ""
                async for event in runner.run_async(
                    user_id=scenario["user_id"],
                    session_id=session.id,
                    new_message=types.Content(
                        role="user",
                        parts=[types.Part.from_text(text=scenario["message"])],
                    ),
                ):
                    if event.content and event.content.parts:
                        for part in event.content.parts:
                            if hasattr(part, "text") and part.text:
                                response_text += part.text

                print(f"\n✓ Response: {response_text[:200]}...")

            except Exception as e:
                print(f"\n❌ Error: {e}")

        print("\n" + "=" * 70)
        print("Demo completed!")
        print("=" * 70 + "\n")

    finally:
        # Clean up MCP session gracefully
        if mcp_toolset and hasattr(mcp_toolset, "close"):
            # Ignore cleanup errors - known ADK/MCP SDK issue
            with contextlib.suppress(Exception):
                await mcp_toolset.close()


if __name__ == "__main__":
    # Try to load .env file if python-dotenv is available
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\nDemo interrupted by user.")
    except Exception as e:
        print(f"\n\n❌ Demo failed: {e}")
