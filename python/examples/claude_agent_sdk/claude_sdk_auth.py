"""Denied authorization callback with Claude Agent SDK.

This example intercepts Claude Code's BUILT-IN tools (Read, Write, Bash, Edit, etc.)
before they execute. The Denied callback checks authorization for each tool call.

Two scenarios test the same request with different user roles:
- Admin (role='admin'): can use Write tool (create action allowed)
- Viewer (role='viewer'): blocked from Write tool (create action denied)

How it works:
1. User sends message: "Create a file called hello.txt"
2. Claude Code decides to use its built-in Write tool
3. SDK calls our permission callback with: tool_name="Write", input={file_path: ...}
4. Callback sends check to Denied with principal_attributes={"role": "viewer"}
5. Denied evaluates policy → DENY (viewer can't create)
6. Callback returns PermissionResultDeny
7. Claude receives denial, cannot complete the action

Policy Rules (in Denied):
- Allow: input.principal.attributes.role == 'admin' (all actions)
- Allow: input.principal.attributes.role == 'viewer' AND input.action == 'read'

Setup:
1. Install: pip install denied-sdk[claude-sdk]
2. Set env vars:
   export ANTHROPIC_API_KEY='your-key'
   export DENIED_API_KEY='your-key'
   export DENIED_URL='https://app.denied.dev/pdp/123'
3. Run: python examples/claude_sdk_auth.py
"""

import asyncio
import os

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    TextBlock,
)

from denied_sdk.integrations.claude_sdk import (
    AuthorizationConfig,
    create_denied_permission_callback,
)


async def run_scenario(name: str, user_id: str, role: str, scope: str, message: str):
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

    # Create permission callback - this intercepts ALL built-in tool calls
    # (Read, Write, Edit, Bash, Glob, Grep, WebFetch, Task, etc.)
    permission_callback = create_denied_permission_callback(
        config=config,
        user_id=user_id,
        principal_attributes={"role": role},
        resource_attributes={"scope": scope},
    )

    # IMPORTANT: Do NOT use allowed_tools here!
    # allowed_tools auto-approves tools without going through the permission callback.
    # We want all tool calls to go through our Denied authorization callback.
    options = ClaudeAgentOptions(
        model="claude-3-5-haiku-20241022",  # Cheapest model
        can_use_tool=permission_callback,
        cwd="/tmp",
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
    """Run the authorization demo."""
    print("=" * 60)
    print("Claude Agent SDK + Denied Authorization")
    print("=" * 60)
    print("\nThis demo intercepts Claude Code's BUILT-IN tools:")
    print("Read, Write, Edit, Bash, Glob, Grep, WebFetch, Task, etc.")
    print("\nEach tool call goes through our permission callback → Denied")

    await run_scenario(
        name="Admin writes file (Write tool → ALLOW)",
        user_id="alice",
        role="user",
        scope="admin",
        message="Create a file /tmp/hello.txt with contents 'Hello World'",
    )

    await run_scenario(
        name="Viewer writes file (Write tool → DENY)",
        user_id="alice",
        role="user",
        scope="user",
        message="Create a file /tmp/hello.txt with contents 'Hello World'",
    )

    await run_scenario(
        name="Viewer reads file (Read tool → ALLOW)",
        user_id="alice",
        role="user",
        scope="user",
        message="Read the contents of /tmp/hello.txt",
    )

    print("\n" + "=" * 60)
    print("Demo completed!")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass

    if not os.getenv("ANTHROPIC_API_KEY"):
        print("❌ ANTHROPIC_API_KEY not set")
        exit(1)

    if not os.getenv("DENIED_URL"):
        print("❌ DENIED_URL not set")
        exit(1)

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nInterrupted")
