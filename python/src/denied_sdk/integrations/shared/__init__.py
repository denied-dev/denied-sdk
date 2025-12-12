"""Shared components for Denied SDK integrations."""

from denied_sdk.integrations.shared.action_patterns import extract_action
from denied_sdk.integrations.shared.errors import (
    AuthorizationDeniedError,
    AuthorizationError,
    AuthorizationServiceError,
    ConfigurationError,
)

__all__ = [
    "extract_action",
    "AuthorizationError",
    "AuthorizationDeniedError",
    "AuthorizationServiceError",
    "ConfigurationError",
]
