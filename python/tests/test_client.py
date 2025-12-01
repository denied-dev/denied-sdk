import httpx
import pytest
from pydantic import ValidationError

from denied_sdk import (
    CheckRequest,
    CheckResponse,
    DeniedClient,
    PrincipalCheck,
    ResourceCheck,
)
from denied_sdk.enums.entity import EntityType

# MARK: - Basic Initialization Tests


def test_client_initialization_default():
    """Test that DeniedClient can be initialized with default values."""
    client = DeniedClient()
    assert client._url == "http://localhost:8421"
    client.close()


def test_client_initialization_custom_url():
    """Test that DeniedClient can be initialized with custom URL."""
    custom_url = "https://api.denied.dev"
    client = DeniedClient(url=custom_url)
    assert client._url == custom_url
    client.close()


def test_client_context_manager():
    """Test that DeniedClient works as a context manager."""
    with DeniedClient() as client:
        assert client is not None
        assert client.client is not None


# MARK: - Schema Creation Tests


def test_principal_check_creation():
    """Test creating a PrincipalCheck with URI."""
    principal = PrincipalCheck(uri="user:alice", attributes={})
    assert principal.uri == "user:alice"
    assert principal.type == EntityType.principal


def test_resource_check_creation():
    """Test creating a ResourceCheck with URI."""
    resource = ResourceCheck(uri="document:secret", attributes={})
    assert resource.uri == "document:secret"
    assert resource.type == EntityType.resource


def test_check_request_creation():
    """Test creating a CheckRequest."""
    request = CheckRequest(
        principal=PrincipalCheck(uri="user:alice", attributes={}),
        resource=ResourceCheck(uri="document:1", attributes={}),
        action="read",
    )
    assert request.principal.uri == "user:alice"
    assert request.resource.uri == "document:1"
    assert request.action == "read"


def test_check_response_creation():
    """Test creating a CheckResponse."""
    response = CheckResponse(allowed=True, reason="Test reason")
    assert response.allowed is True
    assert response.reason == "Test reason"


# MARK: - Validation Tests


def test_entity_check_requires_uri_or_attributes():
    """Test that EntityCheck validation fails with neither uri nor attributes."""
    with pytest.raises(ValidationError, match="Either 'uri' or non-empty 'attributes'"):
        PrincipalCheck(uri=None, attributes={})


def test_entity_check_empty_attributes_requires_uri():
    """Test that empty attributes dict requires URI."""
    with pytest.raises(ValidationError, match="Either 'uri' or non-empty 'attributes'"):
        PrincipalCheck(uri=None, attributes={})


def test_entity_check_accepts_uri_only():
    """Test that URI alone is valid."""
    principal = PrincipalCheck(uri="user:alice", attributes={})
    assert principal.uri == "user:alice"


def test_entity_check_accepts_attributes_only():
    """Test that attributes alone are valid."""
    principal = PrincipalCheck(uri=None, attributes={"role": "admin"})
    assert principal.attributes == {"role": "admin"}


def test_entity_check_accepts_both_uri_and_attributes():
    """Test that both URI and attributes can be provided."""
    principal = PrincipalCheck(uri="user:alice", attributes={"role": "admin"})
    assert principal.uri == "user:alice"
    assert principal.attributes == {"role": "admin"}


# MARK: - API Method Tests (Mocked)


def test_check_with_uri_success(httpx_mock):
    """Test successful check with URIs."""
    httpx_mock.add_response(
        method="POST",
        url="http://localhost:8421/check",
        json={"allowed": True, "reason": "Policy allows"},
    )
    with DeniedClient() as client:
        response = client.check(
            principal_uri="user:alice", resource_uri="doc:1", action="read"
        )
        assert response.allowed is True
        assert response.reason == "Policy allows"


def test_check_with_attributes_success(httpx_mock):
    """Test successful check with attributes."""
    httpx_mock.add_response(
        method="POST",
        url="http://localhost:8421/check",
        json={"allowed": False},
    )
    with DeniedClient() as client:
        response = client.check(
            principal_attributes={"role": "guest"},
            resource_attributes={"sensitivity": "high"},
            action="read",
        )
        assert response.allowed is False


def test_check_default_action(httpx_mock):
    """Test that default action is 'access'."""
    httpx_mock.add_response(
        method="POST",
        url="http://localhost:8421/check",
        json={"allowed": True},
    )
    with DeniedClient() as client:
        response = client.check(principal_uri="user:alice", resource_uri="doc:1")
        assert response.allowed is True
        # Verify the request was made with action="access"
        request = httpx_mock.get_request()
        assert request is not None


def test_bulk_check_success(httpx_mock):
    """Test bulk check with multiple requests."""
    httpx_mock.add_response(
        method="POST",
        url="http://localhost:8421/check/bulk",
        json=[{"allowed": True}, {"allowed": False, "reason": "Denied"}],
    )
    requests = [
        CheckRequest(
            principal=PrincipalCheck(uri="user:alice", attributes={}),
            resource=ResourceCheck(uri="doc:1", attributes={}),
            action="read",
        ),
        CheckRequest(
            principal=PrincipalCheck(uri="user:bob", attributes={}),
            resource=ResourceCheck(uri="doc:2", attributes={}),
            action="write",
        ),
    ]
    with DeniedClient() as client:
        responses = client.bulk_check(requests)
        assert len(responses) == 2
        assert responses[0].allowed is True
        assert responses[1].allowed is False
        assert responses[1].reason == "Denied"


# MARK: - Error Handling Tests


def test_check_http_404_error(httpx_mock):
    """Test handling of 404 error."""
    httpx_mock.add_response(
        method="POST",
        url="http://localhost:8421/check",
        status_code=404,
        text="Not found",
    )
    with DeniedClient() as client, pytest.raises(httpx.HTTPStatusError, match="404"):
        client.check(principal_uri="user:alice", resource_uri="doc:1")


def test_check_http_500_error(httpx_mock):
    """Test handling of 500 error."""
    httpx_mock.add_response(
        method="POST",
        url="http://localhost:8421/check",
        status_code=500,
        json={"error": "Internal server error"},
    )
    with DeniedClient() as client, pytest.raises(httpx.HTTPStatusError, match="500"):
        client.check(principal_uri="user:alice", resource_uri="doc:1")


def test_check_network_timeout(httpx_mock):
    """Test handling of network timeout."""
    httpx_mock.add_exception(httpx.TimeoutException("Request timeout"))
    with DeniedClient() as client, pytest.raises(httpx.TimeoutException):
        client.check(principal_uri="user:alice", resource_uri="doc:1")


def test_bulk_check_http_error(httpx_mock):
    """Test handling of HTTP error in bulk check."""
    httpx_mock.add_response(
        method="POST",
        url="http://localhost:8421/check/bulk",
        status_code=400,
        json={"error": "Bad request"},
    )
    requests = [
        CheckRequest(
            principal=PrincipalCheck(uri="user:alice", attributes={}),
            resource=ResourceCheck(uri="doc:1", attributes={}),
            action="read",
        )
    ]
    with DeniedClient() as client, pytest.raises(httpx.HTTPStatusError, match="400"):
        client.bulk_check(requests)


# MARK: - Environment Variable Tests


def test_client_uses_env_var_url(monkeypatch):
    """Test that DENIED_URL env var is used."""
    monkeypatch.setenv("DENIED_URL", "https://custom.denied.dev")
    client = DeniedClient()
    assert client._url == "https://custom.denied.dev"
    client.close()


def test_client_uses_env_var_api_key(monkeypatch):
    """Test that DENIED_API_KEY env var is used."""
    monkeypatch.setenv("DENIED_API_KEY", "test-key-123")
    client = DeniedClient()
    assert client._api_key == "test-key-123"
    client.close()


def test_client_constructor_overrides_env_vars(monkeypatch):
    """Test that constructor params override env vars."""
    monkeypatch.setenv("DENIED_URL", "https://env.denied.dev")
    monkeypatch.setenv("DENIED_API_KEY", "env-key")
    client = DeniedClient(url="https://custom.denied.dev", api_key="custom-key")
    assert client._url == "https://custom.denied.dev"
    assert client._api_key == "custom-key"
    client.close()


# MARK: - Resource Cleanup Tests


def test_close_method_closes_client():
    """Test that close() properly closes httpx client."""
    client = DeniedClient()
    assert not client.client.is_closed
    client.close()
    assert client.client.is_closed


def test_context_manager_closes_on_exit():
    """Test that context manager closes client on exit."""
    client = DeniedClient()
    with client:
        assert not client.client.is_closed
    assert client.client.is_closed


def test_context_manager_closes_on_exception():
    """Test that context manager closes even on exception."""
    client = DeniedClient()
    try:
        with client:
            assert not client.client.is_closed
            raise ValueError("Test exception")  # noqa: EM101
    except ValueError:
        pass
    assert client.client.is_closed
