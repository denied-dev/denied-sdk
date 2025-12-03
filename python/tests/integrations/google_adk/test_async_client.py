"""Tests for AsyncDeniedClient."""

import pytest

from denied_sdk.integrations.google_adk.async_client import AsyncDeniedClient
from denied_sdk.schemas.check import CheckResponse


@pytest.mark.asyncio
async def test_async_client_check(httpx_mock):
    """Test async check method."""
    # Mock the Denied API response
    httpx_mock.add_response(
        method="POST",
        url="http://localhost:8421/check",
        json={"allowed": True, "reason": None, "rules": []},
    )

    async with AsyncDeniedClient(url="http://localhost:8421") as client:
        response = await client.check(
            principal_uri="user:alice",
            resource_uri="tool:write_file",
            action="execute",
        )

        assert isinstance(response, CheckResponse)
        assert response.allowed is True


@pytest.mark.asyncio
async def test_async_client_check_denied(httpx_mock):
    """Test async check with denial."""
    httpx_mock.add_response(
        method="POST",
        url="http://localhost:8421/check",
        json={"allowed": False, "reason": "Insufficient permissions", "rules": []},
    )

    async with AsyncDeniedClient() as client:
        response = await client.check(
            principal_uri="user:bob",
            resource_uri="tool:delete_database",
            action="execute",
        )

        assert response.allowed is False
        assert response.reason == "Insufficient permissions"


@pytest.mark.asyncio
async def test_async_client_with_attributes(httpx_mock):
    """Test async check with attributes."""
    httpx_mock.add_response(
        method="POST",
        url="http://localhost:8421/check",
        json={"allowed": True, "reason": None, "rules": []},
    )

    async with AsyncDeniedClient() as client:
        response = await client.check(
            principal_attributes={"role": "admin", "department": "engineering"},
            resource_attributes={"tool_name": "write_file", "file_path": "/etc/passwd"},
            action="write",
        )

        assert response.allowed is True


@pytest.mark.asyncio
async def test_async_client_bulk_check(httpx_mock):
    """Test async bulk_check method."""
    from denied_sdk.enums.entity import EntityType
    from denied_sdk.schemas.check import CheckRequest, PrincipalCheck, ResourceCheck

    httpx_mock.add_response(
        method="POST",
        url="http://localhost:8421/check/bulk",
        json=[
            {"allowed": True, "reason": None, "rules": []},
            {"allowed": False, "reason": "Access denied", "rules": []},
        ],
    )

    requests = [
        CheckRequest(
            principal=PrincipalCheck(
                type=EntityType.principal, uri="user:alice", attributes={}
            ),
            resource=ResourceCheck(
                type=EntityType.resource, uri="tool:read_file", attributes={}
            ),
            action="execute",
        ),
        CheckRequest(
            principal=PrincipalCheck(
                type=EntityType.principal, uri="user:bob", attributes={}
            ),
            resource=ResourceCheck(
                type=EntityType.resource, uri="tool:write_file", attributes={}
            ),
            action="execute",
        ),
    ]

    async with AsyncDeniedClient() as client:
        responses = await client.bulk_check(requests)

        assert len(responses) == 2
        assert responses[0].allowed is True
        assert responses[1].allowed is False


@pytest.mark.asyncio
async def test_async_client_context_manager():
    """Test async context manager."""
    client = AsyncDeniedClient()

    async with client:
        assert client._client is not None

    # Client should be closed after exiting context
    assert client._client.client.is_closed
