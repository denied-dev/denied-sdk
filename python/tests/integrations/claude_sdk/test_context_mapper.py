"""Tests for ContextMapper."""

import pytest

from denied_sdk.integrations.claude_sdk.config import AuthorizationConfig
from denied_sdk.integrations.claude_sdk.context_mapper import ContextMapper


@pytest.fixture
def config():
    """Create a basic config."""
    return AuthorizationConfig(
        user_id="alice",
        session_id="session-123",
    )


@pytest.fixture
def mapper(config):
    """Create a context mapper."""
    return ContextMapper(config)


@pytest.fixture
def mapper_with_attributes(config):
    """Create a context mapper with principal attributes."""
    return ContextMapper(
        config, principal_attributes={"role": "admin", "department": "eng"}
    )


def test_extract_principal(mapper):
    """Test extracting principal from config."""
    principal = mapper.extract_principal()

    assert principal.uri == "user:alice"
    assert principal.attributes["user_id"] == "alice"
    assert principal.attributes["session_id"] == "session-123"


def test_extract_principal_no_user_id():
    """Test extracting principal without user_id."""
    config = AuthorizationConfig(user_id=None, session_id=None)
    mapper = ContextMapper(config)

    principal = mapper.extract_principal()

    assert principal.uri == "user:claude-agent"  # Default
    assert principal.attributes is None


def test_extract_principal_with_only_session():
    """Test extracting principal with only session_id."""
    config = AuthorizationConfig(user_id=None, session_id="sess-456")
    mapper = ContextMapper(config)

    principal = mapper.extract_principal()

    assert principal.uri == "user:claude-agent"
    assert principal.attributes["session_id"] == "sess-456"


def test_extract_principal_with_attributes(mapper_with_attributes):
    """Test extracting principal with custom attributes."""
    principal = mapper_with_attributes.extract_principal()

    assert principal.uri == "user:alice"
    # Custom attributes should be included
    assert principal.attributes["role"] == "admin"
    assert principal.attributes["department"] == "eng"
    # Config attributes should also be included
    assert principal.attributes["user_id"] == "alice"
    assert principal.attributes["session_id"] == "session-123"


def test_extract_principal_attributes_only():
    """Test extracting principal with only custom attributes, no user_id."""
    config = AuthorizationConfig(user_id=None, session_id=None)
    mapper = ContextMapper(config, principal_attributes={"role": "viewer"})

    principal = mapper.extract_principal()

    assert principal.uri == "user:claude-agent"
    assert principal.attributes["role"] == "viewer"


def test_extract_resource(mapper):
    """Test extracting resource from tool."""
    tool_input = {"file_path": "/etc/passwd", "content": "secret"}

    resource = mapper.extract_resource("Write", tool_input)

    assert resource.uri == "tool:Write"
    assert resource.attributes["tool_name"] == "Write"
    # tool_input should be wrapped in {"values": ...} structure
    assert resource.attributes["tool_input"]["values"]["file_path"] == "/etc/passwd"
    assert resource.attributes["tool_input"]["values"]["content"] == "secret"


def test_extract_resource_no_args(mapper):
    """Test extracting resource with no arguments."""
    resource = mapper.extract_resource("Read", {})

    assert resource.uri == "tool:Read"
    assert resource.attributes["tool_name"] == "Read"
    # Empty dict should not be included
    assert "tool_input" not in resource.attributes


def test_extract_resource_disable_args():
    """Test that tool_input is excluded when extract_tool_args=False."""
    config = AuthorizationConfig(extract_tool_args=False)
    mapper = ContextMapper(config)

    resource = mapper.extract_resource("Write", {"file_path": "/test"})

    assert "tool_input" not in resource.attributes


def test_create_check_request(mapper):
    """Test creating a complete check request."""
    tool_input = {"file_path": "/home/user/data.txt"}

    request = mapper.create_check_request("Write", tool_input)

    # Check principal
    assert request.principal.uri == "user:alice"
    assert request.principal.attributes["user_id"] == "alice"
    assert request.principal.attributes["session_id"] == "session-123"

    # Check resource
    assert request.resource.uri == "tool:Write"
    assert request.resource.attributes["tool_name"] == "Write"
    assert (
        request.resource.attributes["tool_input"]["values"]["file_path"]
        == "/home/user/data.txt"
    )

    # Check action
    assert request.action == "create"


def test_create_check_request_read_tool():
    """Test check request for a read tool."""
    config = AuthorizationConfig(user_id="bob")
    mapper = ContextMapper(config)

    request = mapper.create_check_request("Read", {"file_path": "/var/log/app.log"})

    assert request.principal.uri == "user:bob"
    assert request.resource.uri == "tool:Read"
    assert request.action == "read"
