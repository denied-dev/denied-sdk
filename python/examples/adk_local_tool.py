"""Denied authorization plugin with local Python function tool.

Agent uses a simple read_project() function.
The Denied plugin checks authorization before calling the tool. Two scenarios
test the same user reading projects with different resource scopes: user-scoped
(allowed) vs admin-scoped (denied).

Policy Rule (in Denied):
- Allow: principal.role='user' AND resource.scope='user' AND action='read'

Setup:
1. Install: pip install denied-sdk[adk] (or: uv add denied-sdk[adk])

2. Set environment variables:
   export GEMINI_API_KEY='your-key'
   export DENIED_API_KEY='your-key'
   export DENIED_URL='your-pdp-url'

3. Run the example:
   python examples/adk_scope_example.py
"""

import asyncio
import os

from google.adk import Agent, Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.genai import types

from denied_sdk.integrations.google_adk import AuthorizationConfig, AuthorizationPlugin


# Define tool without scope parameter (scope comes from session state)
def read_project(project_id: str) -> dict:
    """Read project data.

    Args:
        project_id: ID of the project to read.

    Returns:
        Dictionary with project data.
    """
    return {
        "project_id": project_id,
        "data": f"[Mock] Project {project_id} contents",
        "status": "success",
    }


async def main():
    """Run the scope-based authorization demo."""
    # Create agent with the read_project tool
    agent = Agent(
        name="project_assistant",
        model="gemini-2.0-flash-exp",
        instruction="You are a project assistant. Help users read project data.",
        tools=[read_project],
    )

    # Configure authorization plugin
    config = AuthorizationConfig(
        denied_url=os.getenv("DENIED_URL"),
        denied_api_key=os.getenv("DENIED_API_KEY"),
        fail_mode="closed",
        # Extract role from session state into principal attributes
        principal_state_keys=["role"],
        # Extract scope from session state into resource attributes
        resource_state_keys=["scope"],
    )

    # Create runner with authorization plugin
    session_service = InMemorySessionService()
    runner = Runner(
        app_name="scope_demo",
        agent=agent,
        session_service=session_service,
        plugins=[AuthorizationPlugin(config)],
    )

    # Test scenarios
    scenarios = [
        {
            "name": "User reads user-scoped project (should ALLOW)",
            "user_id": "alice",
            "role": "user",
            "scope": "user",
            "project_id": "prj-default-project",
            "message": "Read project prj-default-project",
        },
        {
            "name": "User reads admin-scoped project (should DENY)",
            "user_id": "alice",
            "role": "user",
            "scope": "admin",
            "project_id": "prj-default-project",
            "message": "Read project prj-default-project",
        },
    ]

    for i, scenario in enumerate(scenarios, 1):
        print(f"\n{'-' * 60}")
        print(f"Scenario {i}: {scenario['name']}")
        print(f"User: {scenario['user_id']} (role: {scenario['role']})")
        print(f"Resource: project with scope={scenario['scope']}")
        print(f"Request: {scenario['message']}")
        print(f"{'-' * 60}")

        # Create session with role and scope in state
        session = await session_service.create_session(
            app_name="scope_demo",
            user_id=scenario["user_id"],
            state={
                "role": scenario["role"],
                "scope": scenario["scope"],
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

            print(f"\n✓ Response: {response_text}")

        except Exception as e:
            print(f"\n❌ Error: {e}")

    print("\n" + "=" * 60)
    print("Demo completed!")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    # Try to load .env file if python-dotenv is available
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass

    # Check for API keys
    if not os.getenv("GEMINI_API_KEY"):
        print("❌ Error: GEMINI_API_KEY environment variable not set")
        exit(1)

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\nDemo interrupted by user.")
    except Exception as e:
        print(f"\n\n❌ Demo failed: {e}")
