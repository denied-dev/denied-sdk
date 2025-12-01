"""Basic smoke tests for DeniedClient."""

from denied_sdk import (
    CheckRequest,
    CheckResponse,
    DeniedClient,
    PrincipalCheck,
    ResourceCheck,
)
from denied_sdk.enums.entity import EntityType


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
