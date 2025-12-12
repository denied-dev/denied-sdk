"""Shared error classes for authorization integrations.

These exceptions are used across different SDK integrations
(Claude Agent SDK, Google ADK, etc.) to handle authorization failures.
"""


class AuthorizationError(Exception):
    """Base exception for authorization-related errors."""


class AuthorizationDeniedError(AuthorizationError):
    """Raised when an authorization check explicitly denies access."""

    def __init__(self, reason: str | None = None):
        self.reason = reason
        message = (
            f"Authorization denied: {reason}" if reason else "Authorization denied"
        )
        super().__init__(message)


class AuthorizationServiceError(AuthorizationError):
    """Raised when the authorization service is unavailable or returns an error."""

    def __init__(self, message: str, original_error: Exception | None = None):
        self.original_error = original_error
        super().__init__(message)


class ConfigurationError(AuthorizationError):
    """Raised when there is a configuration error."""
