"""Tests for AsyncDeniedClient."""

import pytest

from denied_sdk import AsyncDeniedClient
from denied_sdk.schemas.check import (
    Action,
    CheckRequest,
    CheckResponse,
    Resource,
    Subject,
)


@pytest.mark.asyncio
async def test_async_client_check(httpx_mock):
    """Test async check method with URI string inputs."""
    httpx_mock.add_response(
        method="POST",
        url="http://localhost:8421/pdp/check",
        json={"decision": True, "context": {"reason": None, "rules": []}},
    )

    async with AsyncDeniedClient(url="http://localhost:8421") as client:
        response = await client.check(
            subject="user://alice",
            resource="tool://write_file",
            action="execute",
        )

        assert isinstance(response, CheckResponse)
        assert response.decision is True


@pytest.mark.asyncio
async def test_async_client_check_denied(httpx_mock):
    """Test async check with denial using URI strings."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check",
        json={
            "decision": False,
            "context": {"reason": "Insufficient permissions", "rules": []},
        },
    )

    async with AsyncDeniedClient() as client:
        response = await client.check(
            subject="user://bob",
            resource="tool://delete_database",
            action="execute",
        )

        assert response.decision is False
        assert response.context.reason == "Insufficient permissions"


@pytest.mark.asyncio
async def test_async_client_with_objects(httpx_mock):
    """Test async check with typed objects including properties."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check",
        json={"decision": True, "context": {"reason": None, "rules": []}},
    )

    async with AsyncDeniedClient() as client:
        response = await client.check(
            subject=Subject(
                type="user",
                id="admin",
                properties={"role": "admin", "department": "engineering"},
            ),
            resource=Resource(
                type="tool", id="write_file", properties={"file_path": "/etc/passwd"}
            ),
            action="write",
        )

        assert response.decision is True


@pytest.mark.asyncio
async def test_async_client_with_dicts(httpx_mock):
    """Test async check with dict inputs."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check",
        json={"decision": True},
    )

    async with AsyncDeniedClient() as client:
        response = await client.check(
            subject={"type": "user", "id": "alice", "properties": {"role": "admin"}},
            resource={"type": "document", "id": "1"},
            action={"name": "read"},
        )

        assert response.decision is True


@pytest.mark.asyncio
async def test_async_client_bulk_check(httpx_mock):
    """Test async bulk_check method."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check/bulk",
        json=[
            {"decision": True, "context": {"reason": None, "rules": []}},
            {"decision": False, "context": {"reason": "Access denied", "rules": []}},
        ],
    )

    requests = [
        CheckRequest(
            subject=Subject(type="user", id="alice", properties={}),
            resource=Resource(type="tool", id="read_file", properties={}),
            action=Action(name="execute"),
        ),
        CheckRequest(
            subject=Subject(type="user", id="bob", properties={}),
            resource=Resource(type="tool", id="write_file", properties={}),
            action=Action(name="execute"),
        ),
    ]

    async with AsyncDeniedClient() as client:
        responses = await client.bulk_check(requests)

        assert len(responses) == 2
        assert responses[0].decision is True
        assert responses[1].decision is False


@pytest.mark.asyncio
async def test_async_client_context_manager():
    """Test async context manager."""
    client = AsyncDeniedClient()

    async with client:
        assert client.client is not None

    assert client.client.is_closed
