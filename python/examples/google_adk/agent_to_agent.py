"""Customer Service Escalation - Agent-to-Agent Authorization Demo.

Demonstrates ADK's sub_agents feature with Denied authorization:
- Tier-1 agent handles basic queries, delegates privileged ops to Supervisor
- Supervisor sub-agent processes refunds/account changes
- Authorization checks agent_name to enforce per-agent permissions

When Tier-1 delegates to Supervisor, the tool_context.agent_name changes,
allowing the Rego policy to grant different permissions per agent.

Policy Rules (in Denied):
```rego
# Tier-1 agent can only read
allow {
    input.principal.attributes.agent_name == "tier1_support"
    input.action == "read"
}

# Allow tier1 to delegate to supervisor
allow {
    input.principal.attributes.agent_name == "tier1_support"
    input.resource.attributes.tool_name == "transfer_to_agent"
}

# Supervisor agent can do everything
allow {
    input.principal.attributes.agent_name == "supervisor_support"
}
```

Setup:
1. Install: pip install denied-sdk[adk] (or: uv add denied-sdk[adk])
2. Set env vars:
   export GEMINI_API_KEY='your-key'
   export DENIED_API_KEY='your-key'
   export DENIED_URL='https://app.denied.dev/pdp/123'
3. Run: python examples/adk_agent_to_agent.py
"""

import asyncio
import logging
import os

from google.adk import Agent, Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.genai import types

from denied_sdk.integrations.google_adk import AuthorizationConfig, AuthorizationPlugin

# Enable logging for relevant components only
logging.basicConfig(level=logging.INFO)
logging.getLogger("denied_sdk").setLevel(logging.DEBUG)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)

# --- Mock Tools ---


def get_customer(customer_id: str) -> dict:
    """Get customer information by ID."""
    return {
        "customer_id": customer_id,
        "name": "Jane Doe",
        "email": "jane@example.com",
        "tier": "gold",
    }


def get_order_status(order_id: str) -> dict:
    """Get the status of an order."""
    return {
        "order_id": order_id,
        "status": "delivered",
        "total": 149.99,
        "date": "2024-01-15",
    }


def create_refund(order_id: str, amount: float, reason: str) -> dict:
    """Process a refund for an order. Requires supervisor privileges."""
    return {
        "order_id": order_id,
        "refund_amount": amount,
        "reason": reason,
        "status": "processed",
        "refund_id": "REF-12345",
    }


def update_account(customer_id: str, field: str, value: str) -> dict:
    """Update customer account field. Requires supervisor privileges."""
    return {"customer_id": customer_id, "updated": {field: value}, "status": "success"}


async def main():
    """Run the agent-to-agent authorization demo."""
    config = AuthorizationConfig(
        denied_url=os.getenv("DENIED_URL"),
        denied_api_key=os.getenv("DENIED_API_KEY"),
        fail_mode="closed",
    )
    plugin = AuthorizationPlugin(config)
    session_service = InMemorySessionService()

    # Supervisor sub-agent: handles privileged operations
    # Authorization allows this agent to call issue_refund, update_account
    supervisor_agent = Agent(
        name="supervisor_support",
        model="gemini-2.0-flash-exp",
        description="Supervisor agent for privileged operations: refunds, account changes. Delegate here when customer needs a refund or account modification.",
        instruction="You are a support supervisor. Process the refund or account change request, then return control to the main agent.",
        tools=[create_refund, update_account],
    )

    # Tier-1 agent: handles basic queries, delegates privileged ops
    # Authorization only allows this agent to call read operations
    tier1_agent = Agent(
        name="tier1_support",
        model="gemini-2.0-flash-exp",
        description="Tier-1 support agent for customer inquiries.",
        instruction="""You are a Tier-1 support agent. You can look up customers and orders.
For refunds or account changes, delegate to the supervisor_support agent.
After supervisor completes the task, summarize the result for the customer.""",
        tools=[get_customer, get_order_status],
        sub_agents=[supervisor_agent],
    )

    runner = Runner(
        app_name="support_demo",
        agent=tier1_agent,
        session_service=session_service,
        plugins=[plugin],
    )

    print("=" * 60)
    print("Agent-to-Agent Authorization Demo")
    print("=" * 60)

    # Scenario: Customer asks for order status, then requests refund
    # - Tier-1 handles lookup via get_order_status (ALLOWED - read action)
    # - Tier-1 delegates to Supervisor for refund
    # - Supervisor calls issue_refund (ALLOWED - supervisor_support agent)
    scenarios = [
        {
            "name": "Order lookup (Tier-1 handles directly)",
            "message": "What's the status of order ORD-9876?",
        },
        {
            "name": "Refund request (Tier-1 delegates to Supervisor)",
            "message": "I need a $50 refund for order ORD-9876, the item was damaged.",
        },
    ]

    for scenario in scenarios:
        print(f"\n[{scenario['name']}]")
        print(f"  Message: {scenario['message']}")

        session = await session_service.create_session(
            app_name="support_demo",
            user_id="customer_123",
            state={},
        )

        response_text = ""
        async for event in runner.run_async(
            user_id="customer_123",
            session_id=session.id,
            new_message=types.Content(
                role="user", parts=[types.Part.from_text(text=scenario["message"])]
            ),
        ):
            if event.content and event.content.parts:
                for part in event.content.parts:
                    if hasattr(part, "text") and part.text:
                        response_text += part.text

        print(f"  Response: {response_text[:200]}...")

    print("\n" + "=" * 60)
    print("Demo completed")
    print("=" * 60)


if __name__ == "__main__":
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass

    if not os.getenv("GEMINI_API_KEY"):
        print("Error: GEMINI_API_KEY not set")
        exit(1)

    asyncio.run(main())
