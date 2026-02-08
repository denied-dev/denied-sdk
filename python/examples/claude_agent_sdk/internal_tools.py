"""Denied authorization callback with Claude Agent SDK.

This example intercepts Claude Code's BUILT-IN tools (Read, Write, Bash, Edit, etc.)
before they execute. The Denied callback checks authorization for each tool call.

Two scenarios demonstrate read vs write permissions:
- Write file: blocked (create action denied)
- Read file: allowed (read action permitted)

How it works:
1. User sends message: "Create a file called hello.txt"
2. Claude decides to use its built-in Write tool
3. SDK calls our permission callback with: tool_name="Write", input={file_path: ...}
4. Callback extracts action="create" and sends check to Denied
5. Denied evaluates policy -> DENY (create not allowed)
6. Callback returns PermissionResultDeny
7. Claude receives denial, cannot complete the action

Bash command analysis:
- The callback analyzes Bash commands to determine actual intent
- "echo hello > file.txt" -> action="create" (file redirect)
- "rm file.txt" -> action="delete"
- "cat file.txt" -> action="read"
- This prevents bypassing Write restrictions via Bash

Policy Rules (in Denied):
- Allow: input.action == "read"
- Deny: everything else (create, update, delete, execute)

Setup:
1. Install: pip install denied-sdk[claude-sdk]
2. Set env vars:
   export ANTHROPIC_API_KEY='your-key'
   export DENIED_API_KEY='your-key'
3. Run: python examples/claude_agent_sdk/internal_tools.py
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


async def run_scenario(name: str, user_id: str, message: str):
    """Run a single authorization scenario."""
    print(f"\n{'=' * 60}")
    print(f"Scenario: {name}")
    print(f"User: {user_id}")
    print(f"Message: {message}")
    print("-" * 60)

    config = AuthorizationConfig(
        denied_url=os.getenv("DENIED_URL"),
        denied_api_key=os.getenv("DENIED_API_KEY"),
        fail_mode="closed",
        timeout_seconds=15.0,
    )

    # Create permission callback - intercepts ALL built-in tool calls
    permission_callback = create_denied_permission_callback(
        config=config,
        user_id=user_id,
    )

    options = ClaudeAgentOptions(
        model="claude-3-5-haiku-20241022",
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
                            print(f"\nClaude: {block.text[:500]}")

                elif isinstance(msg, ResultMessage):
                    print(f"\nDone ({msg.duration_ms}ms)")

    except Exception as e:
        print(f"\nError: {e}")


async def main():
    """Run the authorization demo."""
    print("=" * 60)
    print("Claude Agent SDK + Denied Authorization")
    print("=" * 60)
    print("\nThis demo intercepts Claude Code's BUILT-IN tools:")
    print("Read, Write, Edit, Bash, Glob, Grep, WebFetch, Task, etc.")
    print("\nEach tool call goes through our permission callback -> Denied")

    # First create a file so we have something to read
    print("\n[Setup: Creating test file...]")
    with open("/tmp/hello.txt", "w") as f:  # noqa: PTH123
        f.write("Hello World\n")

    await run_scenario(
        name="Write file (DENY - create action blocked)",
        user_id="alice",
        message="Create a file /tmp/test.txt with contents 'Test content'",
    )

    await run_scenario(
        name="Read file (ALLOW - read action permitted)",
        user_id="alice",
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
        print("ANTHROPIC_API_KEY not set")
        exit(1)

    if not os.getenv("DENIED_URL") and not os.getenv("DENIED_API_KEY"):
        print("DENIED_URL or DENIED_API_KEY not set")
        exit(1)

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nInterrupted")
