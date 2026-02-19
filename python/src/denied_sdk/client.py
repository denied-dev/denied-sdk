import os
from typing import Any

import httpx

from .schemas import CheckRequest, CheckResponse, PrincipalCheck, ResourceCheck


class BaseDeniedClient:
    """
    Base class containing shared configuration and serialization logic
    for Denied authorization clients.

    This class should not be instantiated directly. Use DeniedClient
    for synchronous operations or AsyncDeniedClient for async operations.

    Parameters
    ----------
    url : str, optional
        The base URL of the Denied server.
        Defaults to environment variable "DENIED_URL" or "https://api.denied.dev".
    api_key : str, optional
        The API key for authenticating with the decision node.
        Defaults to environment variable "DENIED_API_KEY" if not provided.
    timeout : float, optional
        Request timeout in seconds. Defaults to 60.0.
    """

    DEFAULT_URL = "https://api.denied.dev"
    DEFAULT_TIMEOUT = 60.0

    def __init__(
        self,
        url: str | None = None,
        api_key: str | None = None,
        timeout: float | None = None,
    ) -> None:
        self._url = (
            url if url is not None else os.getenv("DENIED_URL") or self.DEFAULT_URL
        )
        self._api_key = api_key if api_key is not None else os.getenv("DENIED_API_KEY")
        self._timeout = timeout if timeout is not None else self.DEFAULT_TIMEOUT

    def _build_headers(self) -> dict[str, str]:
        """Build HTTP headers for requests."""
        headers: dict[str, str] = {}
        if self._api_key is not None:
            headers["X-API-Key"] = self._api_key
        return headers

    def _build_check_request(
        self,
        principal_uri: str | None,
        resource_uri: str | None,
        principal_attributes: dict[str, Any] | None,
        resource_attributes: dict[str, Any] | None,
        action: str,
    ) -> CheckRequest:
        """Build a CheckRequest from parameters."""
        if principal_attributes is None:
            principal_attributes = {}
        if resource_attributes is None:
            resource_attributes = {}

        return CheckRequest(
            principal=PrincipalCheck(
                uri=principal_uri, attributes=principal_attributes
            ),
            resource=ResourceCheck(uri=resource_uri, attributes=resource_attributes),
            action=action,
        )

    @staticmethod
    def _handle_response(response: httpx.Response) -> None:
        """
        Handle HTTP response and raise errors if necessary.

        Parameters
        ----------
        response : httpx.Response
            The HTTP response to handle.

        Raises
        ------
        httpx.HTTPStatusError
            If the HTTP request returns an unsuccessful status code.
        """
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            message = f"{e}\nResponse: {e.response.text}"
            raise httpx.HTTPStatusError(
                message,
                request=e.request,
                response=e.response,
            ) from None


class DeniedClient(BaseDeniedClient):
    """
    A synchronous client for interacting with the Denied authorization server.

    This client provides methods to check permissions for principals
    performing actions on resources.

    The client should be used as a context manager to ensure proper cleanup
    of the underlying HTTP connection pool:

        with DeniedClient() as client:
            response = client.check(...)

    Alternatively, call close() manually when done:

        client = DeniedClient()
        try:
            response = client.check(...)
        finally:
            client.close()

    Parameters
    ----------
    url : str, optional
        The base URL of the Denied server.
        Defaults to environment variable "DENIED_URL" or "https://api.denied.dev".
    api_key : str, optional
        The API key for authenticating with the decision node.
        Defaults to environment variable "DENIED_API_KEY" if not provided.
    timeout : float, optional
        Request timeout in seconds. Defaults to 60.0.
    """

    def __init__(
        self,
        url: str | None = None,
        api_key: str | None = None,
        timeout: float | None = None,
    ) -> None:
        super().__init__(url=url, api_key=api_key, timeout=timeout)
        self.client = httpx.Client(
            base_url=self._url,
            headers=self._build_headers(),
            timeout=self._timeout,
        )

    def __enter__(self) -> "DeniedClient":
        """Enter the context manager."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        """Exit the context manager and close the client."""
        self.close()

    def close(self) -> None:
        """
        Close the underlying HTTP client and release resources.

        This method should be called when the client is no longer needed
        to properly clean up the connection pool.
        """
        self.client.close()

    def check(
        self,
        principal_uri: str | None = None,
        resource_uri: str | None = None,
        principal_attributes: dict | None = None,
        resource_attributes: dict | None = None,
        action: str = "access",
    ) -> CheckResponse:
        """
        Check whether a principal has permissions to perform an action on a resource.

        Parameters
        ----------
        principal_uri : str, optional
            The identifier of the principal. Can be provided for registered principals.
        resource_uri : str, optional
            The identifier of the resource. Can be provided for registered resources.
        principal_attributes : dict, optional
            The attributes of the principal. Should be provided if the principal is not registered.
        resource_attributes : dict, optional
            The attributes of the resource. Should be provided if the resource is not registered.
        action : str, optional
            The action to check permissions for. Defaults to "access".

        Returns
        -------
        CheckResponse
            The response containing the allowed flag and the reason for the decision.

        Raises
        ------
        httpx.HTTPStatusError
            If the HTTP request returns an unsuccessful status code.
        """
        request = self._build_check_request(
            principal_uri,
            resource_uri,
            principal_attributes,
            resource_attributes,
            action,
        )
        response = self.client.post("/pdp/check", json=request.model_dump())
        self._handle_response(response)
        return CheckResponse.model_validate(response.json())

    def bulk_check(self, check_requests: list[CheckRequest]) -> list[CheckResponse]:
        """
        Perform a set of permission checks in a single request.

        Parameters
        ----------
        check_requests : list[CheckRequest]
            The list of check requests to perform.

        Returns
        -------
        list[CheckResponse]
            The list of results of the check requests.

        Raises
        ------
        httpx.HTTPStatusError
            If the HTTP request returns an unsuccessful status code.
        """
        response = self.client.post(
            "/pdp/check/bulk",
            json=[request.model_dump() for request in check_requests],
        )
        self._handle_response(response)
        return [CheckResponse.model_validate(result) for result in response.json()]


class AsyncDeniedClient(BaseDeniedClient):
    """
    An asynchronous client for interacting with the Denied authorization server.

    This client provides async methods to check permissions for principals
    performing actions on resources.

    The client should be used as an async context manager to ensure proper cleanup
    of the underlying HTTP connection pool:

        async with AsyncDeniedClient() as client:
            response = await client.check(...)

    Alternatively, call close() manually when done:

        client = AsyncDeniedClient()
        try:
            response = await client.check(...)
        finally:
            await client.close()

    Parameters
    ----------
    url : str, optional
        The base URL of the Denied server.
        Defaults to environment variable "DENIED_URL" or "https://api.denied.dev".
    api_key : str, optional
        The API key for authenticating with the decision node.
        Defaults to environment variable "DENIED_API_KEY" if not provided.
    timeout : float, optional
        Request timeout in seconds. Defaults to 60.0.
    """

    def __init__(
        self,
        url: str | None = None,
        api_key: str | None = None,
        timeout: float | None = None,
    ) -> None:
        super().__init__(url=url, api_key=api_key, timeout=timeout)
        self.client = httpx.AsyncClient(
            base_url=self._url,
            headers=self._build_headers(),
            timeout=self._timeout,
        )

    async def __aenter__(self) -> "AsyncDeniedClient":
        """Enter the async context manager."""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """Exit the async context manager and close the client."""
        await self.close()

    async def close(self) -> None:
        """
        Close the underlying HTTP client and release resources.

        This method should be called when the client is no longer needed
        to properly clean up the connection pool.
        """
        await self.client.aclose()

    async def check(
        self,
        principal_uri: str | None = None,
        resource_uri: str | None = None,
        principal_attributes: dict | None = None,
        resource_attributes: dict | None = None,
        action: str = "access",
    ) -> CheckResponse:
        """
        Asynchronously check whether a principal has permissions.

        Parameters
        ----------
        principal_uri : str, optional
            The identifier of the principal. Can be provided for registered principals.
        resource_uri : str, optional
            The identifier of the resource. Can be provided for registered resources.
        principal_attributes : dict, optional
            The attributes of the principal. Should be provided if the principal is not registered.
        resource_attributes : dict, optional
            The attributes of the resource. Should be provided if the resource is not registered.
        action : str, optional
            The action to check permissions for. Defaults to "access".

        Returns
        -------
        CheckResponse
            The response containing the allowed flag and the reason for the decision.

        Raises
        ------
        httpx.HTTPStatusError
            If the HTTP request returns an unsuccessful status code.
        """
        request = self._build_check_request(
            principal_uri,
            resource_uri,
            principal_attributes,
            resource_attributes,
            action,
        )
        response = await self.client.post("/pdp/check", json=request.model_dump())
        self._handle_response(response)
        return CheckResponse.model_validate(response.json())

    async def bulk_check(
        self, check_requests: list[CheckRequest]
    ) -> list[CheckResponse]:
        """
        Asynchronously perform a set of permission checks in a single request.

        Parameters
        ----------
        check_requests : list[CheckRequest]
            The list of check requests to perform.

        Returns
        -------
        list[CheckResponse]
            The list of results of the check requests.

        Raises
        ------
        httpx.HTTPStatusError
            If the HTTP request returns an unsuccessful status code.
        """
        response = await self.client.post(
            "/pdp/check/bulk",
            json=[request.model_dump() for request in check_requests],
        )
        self._handle_response(response)
        return [CheckResponse.model_validate(result) for result in response.json()]
