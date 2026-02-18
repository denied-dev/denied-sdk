import httpx
import pytest
from pydantic import ValidationError

from denied_sdk import (
    Action,
    CheckRequest,
    CheckResponse,
    CheckResponseContext,
    DeniedClient,
    Resource,
    Subject,
)

# MARK: - Basic Initialization Tests


def test_client_initialization_default():
    """Test that DeniedClient can be initialized with default values."""
    client = DeniedClient()
    assert client._url == "https://api.denied.dev"
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


def test_subject_creation():
    """Test creating a Subject."""
    subject = Subject(type="user", id="alice", properties={"role": "admin"})
    assert subject.type == "user"
    assert subject.id == "alice"
    assert subject.properties == {"role": "admin"}


def test_resource_creation():
    """Test creating a Resource."""
    resource = Resource(type="document", id="secret", properties={"owner": "alice"})
    assert resource.type == "document"
    assert resource.id == "secret"
    assert resource.properties == {"owner": "alice"}


def test_action_creation():
    """Test creating an Action."""
    action = Action(name="read", properties={"scope": "full"})
    assert action.name == "read"
    assert action.properties == {"scope": "full"}


def test_check_request_creation():
    """Test creating a CheckRequest."""
    request = CheckRequest(
        subject=Subject(type="user", id="alice", properties={}),
        resource=Resource(type="document", id="1", properties={}),
        action=Action(name="read"),
    )
    assert request.subject.id == "alice"
    assert request.resource.id == "1"
    assert request.action.name == "read"


def test_check_response_creation():
    """Test creating a CheckResponse."""
    response = CheckResponse(
        decision=True, context=CheckResponseContext(reason="Test reason")
    )
    assert response.decision is True
    assert response.context.reason == "Test reason"


# MARK: - Validation Tests


def test_subject_requires_type_and_id():
    """Test that Subject requires both type and id."""
    with pytest.raises(ValidationError):
        Subject(type="user")
    with pytest.raises(ValidationError):
        Subject(id="alice")


def test_resource_requires_type_and_id():
    """Test that Resource requires both type and id."""
    with pytest.raises(ValidationError):
        Resource(type="document")
    with pytest.raises(ValidationError):
        Resource(id="123")


def test_action_requires_name():
    """Test that Action requires name."""
    with pytest.raises(ValidationError):
        Action()


# MARK: - API Method Tests: Typed Objects


def test_check_with_objects(httpx_mock):
    """Test check with typed Subject, Resource, Action objects."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check",
        json={"decision": True, "context": {"reason": "Policy allows"}},
    )
    with DeniedClient() as client:
        response = client.check(
            subject=Subject(type="user", id="alice", properties={"role": "admin"}),
            resource=Resource(type="document", id="1"),
            action=Action(name="read"),
        )
        assert response.decision is True
        assert response.context.reason == "Policy allows"


def test_check_with_action_object(httpx_mock):
    """Test check with Action object including properties."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check",
        json={"decision": True},
    )
    with DeniedClient() as client:
        response = client.check(
            subject=Subject(type="user", id="alice"),
            resource=Resource(type="document", id="1"),
            action=Action(name="read", properties={"times": "3"}),
        )
        assert response.decision is True


# MARK: - API Method Tests: Dicts


def test_check_with_dicts(httpx_mock):
    """Test check with dict inputs for subject, resource, and action."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check",
        json={"decision": False},
    )
    with DeniedClient() as client:
        response = client.check(
            subject={"type": "user", "id": "bob", "properties": {"role": "guest"}},
            resource={
                "type": "document",
                "id": "2",
                "properties": {"visibility": "secret"},
            },
            action={"name": "write"},
        )
        assert response.decision is False


def test_check_with_dict_action_string_entities(httpx_mock):
    """Test check combining string entities with dict action."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check",
        json={"decision": True},
    )
    with DeniedClient() as client:
        response = client.check(
            subject="user://alice",
            resource="document://1",
            action={"name": "read", "properties": {"scope": "full"}},
        )
        assert response.decision is True


# MARK: - API Method Tests: URI Strings


def test_check_with_uri_strings(httpx_mock):
    """Test check using 'type://id' string format."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check",
        json={"decision": True, "context": {"reason": "Policy allows"}},
    )
    with DeniedClient() as client:
        response = client.check(
            subject="user://alice",
            resource="document://1",
            action="read",
        )
        assert response.decision is True
        assert response.context.reason == "Policy allows"


def test_check_uri_string_with_id_containing_slashes(httpx_mock):
    """Test that URI string with id containing slashes parses correctly."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check",
        json={"decision": True},
    )
    with DeniedClient() as client:
        response = client.check(
            subject="user://org/team/alice",
            resource="document://bucket/folder/file",
            action="read",
        )
        assert response.decision is True

    import json

    body = json.loads(httpx_mock.get_request().content)
    assert body["subject"]["type"] == "user"
    assert body["subject"]["id"] == "org/team/alice"
    assert body["resource"]["type"] == "document"
    assert body["resource"]["id"] == "bucket/folder/file"


def test_check_invalid_uri_string_raises():
    """Test that an invalid URI string raises ValueError."""
    with DeniedClient() as client, pytest.raises(ValueError, match="type://id"):
        client.check(subject="user:alice", action="read", resource="document://1")


# MARK: - API Method Tests: Mixed inputs


def test_check_success(httpx_mock):
    """Test successful check with string action and object subject/resource."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check",
        json={"decision": True, "context": {"reason": "Policy allows"}},
    )
    with DeniedClient() as client:
        response = client.check(
            subject=Subject(type="user", id="alice"),
            resource=Resource(type="document", id="1"),
            action="read",
        )
        assert response.decision is True
        assert response.context.reason == "Policy allows"


def test_check_positional_args(httpx_mock):
    """Test check with all three positional args (subject, action, resource)."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check",
        json={"decision": True},
    )
    with DeniedClient() as client:
        response = client.check(
            Subject(type="user", id="alice"),
            "access",
            Resource(type="document", id="1"),
        )
        assert response.decision is True

    import json

    body = json.loads(httpx_mock.get_request().content)
    assert body["subject"]["type"] == "user"
    assert body["action"]["name"] == "access"
    assert body["resource"]["type"] == "document"


def test_bulk_check_success(httpx_mock):
    """Test bulk check with multiple requests."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check/bulk",
        json=[
            {"decision": True},
            {"decision": False, "context": {"reason": "Denied"}},
        ],
    )
    requests = [
        CheckRequest(
            subject=Subject(type="user", id="alice", properties={}),
            resource=Resource(type="document", id="1", properties={}),
            action=Action(name="read"),
        ),
        CheckRequest(
            subject=Subject(type="user", id="bob", properties={}),
            resource=Resource(type="document", id="2", properties={}),
            action=Action(name="write"),
        ),
    ]
    with DeniedClient() as client:
        responses = client.bulk_check(requests)
        assert len(responses) == 2
        assert responses[0].decision is True
        assert responses[1].decision is False
        assert responses[1].context.reason == "Denied"


# MARK: - Error Handling Tests


def test_check_http_404_error(httpx_mock):
    """Test handling of 404 error."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check",
        status_code=404,
        text="Not found",
    )
    with DeniedClient() as client, pytest.raises(httpx.HTTPStatusError, match="404"):
        client.check(subject="user://alice", action="read", resource="document://1")


def test_check_http_500_error(httpx_mock):
    """Test handling of 500 error."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check",
        status_code=500,
        json={"error": "Internal server error"},
    )
    with DeniedClient() as client, pytest.raises(httpx.HTTPStatusError, match="500"):
        client.check(subject="user://alice", action="read", resource="document://1")


def test_check_network_timeout(httpx_mock):
    """Test handling of network timeout."""
    httpx_mock.add_exception(httpx.TimeoutException("Request timeout"))
    with DeniedClient() as client, pytest.raises(httpx.TimeoutException):
        client.check(subject="user://alice", action="read", resource="document://1")


def test_bulk_check_http_error(httpx_mock):
    """Test handling of HTTP error in bulk check."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.denied.dev/pdp/check/bulk",
        status_code=400,
        json={"error": "Bad request"},
    )
    requests = [
        CheckRequest(
            subject=Subject(type="user", id="alice", properties={}),
            resource=Resource(type="document", id="1", properties={}),
            action=Action(name="read"),
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
