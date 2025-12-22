"""Denied authorization integration for Claude Agent SDK.

This package provides authorization enforcement for Claude Agent SDK
using the Denied authorization service.

Example:
    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
    from denied_sdk.integrations.claude_sdk import create_denied_permission_callback

    # Create the callback with user context
    permission_callback = create_denied_permission_callback(
        user_id="user-123",
        session_id="session-456",
    )

    # Use with Claude Agent SDK
    options = ClaudeAgentOptions(
        can_use_tool=permission_callback,
        permission_mode="default",
    )

    async with ClaudeSDKClient(options) as client:
        await client.query("List files in the current directory")
        async for message in client.receive_response():
            print(message)
"""

from denied_sdk import AsyncDeniedClient

from .callback import create_denied_permission_callback
from .config import AuthorizationConfig
from .context_mapper import ContextMapper
from .errors import (
    AuthorizationDeniedError,
    AuthorizationError,
    AuthorizationServiceError,
    ConfigurationError,
)

__all__ = [
    "create_denied_permission_callback",
    "AuthorizationConfig",
    "AsyncDeniedClient",
    "ContextMapper",
    "AuthorizationError",
    "AuthorizationDeniedError",
    "AuthorizationServiceError",
    "ConfigurationError",
]
