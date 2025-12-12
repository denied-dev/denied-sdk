"""Re-export shared error classes for backwards compatibility."""

from denied_sdk.integrations.shared.errors import (
    AuthorizationDeniedError,
    AuthorizationError,
    AuthorizationServiceError,
    ConfigurationError,
)

__all__ = [
    "AuthorizationError",
    "AuthorizationDeniedError",
    "AuthorizationServiceError",
    "ConfigurationError",
]
