"""Denied authorization integration for Google ADK.

This package provides authorization enforcement for Google ADK agents
using the Denied authorization service.

Example:
    from denied_sdk.integrations.google_adk import AuthorizationPlugin
    from google.adk import LlmAgent, Runner

    agent = LlmAgent(name="my_agent", tools=[...])
    runner = Runner(
        agent=agent,
        plugins=[AuthorizationPlugin()],
    )
"""

from .async_client import AsyncDeniedClient
from .config import AuthorizationConfig
from .context_mapper import ContextMapper
from .errors import (
    AuthorizationDeniedError,
    AuthorizationError,
    AuthorizationServiceError,
    ConfigurationError,
)
from .plugin import AuthorizationPlugin

__all__ = [
    "AuthorizationPlugin",
    "AuthorizationConfig",
    "AsyncDeniedClient",
    "ContextMapper",
    "AuthorizationError",
    "AuthorizationDeniedError",
    "AuthorizationServiceError",
    "ConfigurationError",
]
