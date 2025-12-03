import os
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class AuthorizationConfig(BaseModel):
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

    denied_url: str | None = Field(
        default=None,
        description="URL of the Denied authorization service",
    )
    denied_api_key: str | None = Field(
        default=None,
        description="API key for the Denied service",
    )

    # Failure handling
    fail_mode: Literal["closed", "open"] = Field(
        default="closed",
        description="How to handle authorization service failures",
    )
    retry_attempts: int = Field(
        default=2,
        ge=0,
        description="Number of retry attempts for failed authorization checks",
    )
    timeout_seconds: float = Field(
        default=5.0,
        gt=0,
        description="Timeout for authorization service requests in seconds",
    )

    # Context extraction
    include_user_id: bool = Field(
        default=True,
        description="Whether to include user_id in principal attributes",
    )
    include_agent_name: bool = Field(
        default=True,
        description="Whether to include agent name in principal attributes",
    )
    include_session_id: bool = Field(
        default=True,
        description="Whether to include session ID in principal attributes",
    )
    extract_tool_args: bool = Field(
        default=True,
        description="Whether to extract tool arguments into resource attributes",
    )

    @model_validator(mode="before")
    @classmethod
    def set_env_defaults(cls, values: dict) -> dict:
        """Set defaults from environment variables if not provided."""
        if values.get("denied_url") is None:
            values["denied_url"] = os.getenv("DENIED_URL", "http://localhost:8421")

        if values.get("denied_api_key") is None:
            values["denied_api_key"] = os.getenv("DENIED_API_KEY")

        return values

    @field_validator("denied_url")
    @classmethod
    def validate_denied_url(cls, v: str | None) -> str:
        """Validate that denied_url is provided."""
        if not v:
            msg = "denied_url must be provided or DENIED_URL must be set"
            raise ValueError(msg)
        return v
