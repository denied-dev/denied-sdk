import os
from dataclasses import dataclass
from typing import Literal


@dataclass
class AuthorizationConfig:
    """Configuration for the Denied authorization plugin.

    Attributes:
        denied_url: URL of the Denied authorization service.
            Defaults to DENIED_URL environment variable.
        denied_api_key: API key for the Denied service.
            Defaults to DENIED_API_KEY environment variable.
        fail_mode: How to handle authorization service failures.
            "closed" (default): Deny access when service is unavailable (secure).
            "open": Allow access when service is unavailable (available).
        retry_attempts: Number of retry attempts for failed authorization checks.
        timeout_seconds: Timeout for authorization service requests in seconds.
        include_user_id: Whether to include user_id in principal attributes.
        include_agent_name: Whether to include agent name in principal attributes.
        include_session_id: Whether to include session ID in principal attributes.
        extract_tool_args: Whether to extract tool arguments into resource attributes.
    """

    denied_url: str | None = None
    denied_api_key: str | None = None

    # Failure handling
    fail_mode: Literal["closed", "open"] = "closed"
    retry_attempts: int = 2
    timeout_seconds: float = 5.0

    # Context extraction
    include_user_id: bool = True
    include_agent_name: bool = True
    include_session_id: bool = True
    extract_tool_args: bool = True

    def __post_init__(self):
        """Set defaults from environment variables if not provided."""
        if self.denied_url is None:
            self.denied_url = os.getenv("DENIED_URL", "http://localhost:8421")

        if self.denied_api_key is None:
            self.denied_api_key = os.getenv("DENIED_API_KEY")

    def validate(self) -> None:
        """Validate the configuration.

        Raises:
            ValueError: If configuration is invalid.
        """
        if not self.denied_url:
            msg = "denied_url must be provided or DENIED_URL must be set"
            raise ValueError(msg)

        if self.retry_attempts < 0:
            msg = "retry_attempts must be non-negative"
            raise ValueError(msg)

        if self.timeout_seconds <= 0:
            msg = "timeout_seconds must be positive"
            raise ValueError(msg)
