import asyncio
from typing import Any

from denied_sdk import DeniedClient
from denied_sdk.schemas.check import CheckRequest, CheckResponse


class AsyncDeniedClient:
    """Async wrapper around the synchronous DeniedClient.

    This class wraps the synchronous DeniedClient to provide async methods
    compatible with Google ADK's async architecture. It uses asyncio.to_thread()
    to run synchronous operations in a thread pool.

    Args:
        url: URL of the Denied authorization service.
        api_key: API key for authentication.
        timeout: Request timeout in seconds (default: 5.0).

    Example:
        async with AsyncDeniedClient(url="http://localhost:8421") as client:
            response = await client.check(
                principal_uri="user:alice",
                resource_uri="tool:write_file",
                action="execute"
            )
    """

    def __init__(
        self,
        url: str | None = None,
        api_key: str | None = None,
        timeout: float = 5.0,
    ):
        """Initialize the async client.

        Args:
            url: URL of the Denied service. Defaults to DENIED_URL env var.
            api_key: API key. Defaults to DENIED_API_KEY env var.
            timeout: Request timeout in seconds.
        """
        self._client = DeniedClient(url=url, api_key=api_key)
        # Override the default 60s timeout with a shorter one for tool interception
        self._client.client.timeout = timeout

    async def check(
        self,
        *,
        principal_uri: str | None = None,
        principal_attributes: dict[str, Any] | None = None,
        resource_uri: str | None = None,
        resource_attributes: dict[str, Any] | None = None,
        action: str = "access",
    ) -> CheckResponse:
        """Perform an async authorization check.

        Args:
            principal_uri: URI identifying the principal (e.g., "user:alice").
            principal_attributes: Attributes describing the principal.
            resource_uri: URI identifying the resource (e.g., "tool:write_file").
            resource_attributes: Attributes describing the resource.
            action: The action being performed (default: "access").

        Returns:
            CheckResponse containing the authorization decision.

        Raises:
            httpx.HTTPStatusError: If the request fails.
        """
        return await asyncio.to_thread(
            self._client.check,
            principal_uri=principal_uri,
            principal_attributes=principal_attributes,
            resource_uri=resource_uri,
            resource_attributes=resource_attributes,
            action=action,
        )

    async def bulk_check(self, requests: list[CheckRequest]) -> list[CheckResponse]:
        """Perform multiple async authorization checks.

        Args:
            requests: List of CheckRequest objects.

        Returns:
            List of CheckResponse objects, one for each request.

        Raises:
            httpx.HTTPStatusError: If the request fails.
        """
        return await asyncio.to_thread(self._client.bulk_check, requests)

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await asyncio.to_thread(self._client.close)

    async def __aenter__(self):
        """Async context manager entry."""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        await self.close()
        return False
