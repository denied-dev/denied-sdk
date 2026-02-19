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
def mapper_with_properties(config):
    """Create a context mapper with subject properties."""
    return ContextMapper(
        config, subject_properties={"role": "admin", "department": "eng"}
    )


def test_extract_subject(mapper):
    """Test extracting subject from config."""
    subject = mapper.extract_subject()

    assert subject.type == "user"
    assert subject.id == "alice"
    assert subject.properties["user_id"] == "alice"
    assert subject.properties["session_id"] == "session-123"


def test_extract_subject_no_user_id():
    """Test extracting subject without user_id."""
    config = AuthorizationConfig(user_id=None, session_id=None)
    mapper = ContextMapper(config)

    subject = mapper.extract_subject()

    assert subject.type == "user"
    assert subject.id == "claude-agent"
    assert subject.properties == {}


def test_extract_subject_with_only_session():
    """Test extracting subject with only session_id."""
    config = AuthorizationConfig(user_id=None, session_id="sess-456")
    mapper = ContextMapper(config)

    subject = mapper.extract_subject()

    assert subject.type == "user"
    assert subject.id == "claude-agent"
    assert subject.properties["session_id"] == "sess-456"


def test_extract_subject_with_properties(mapper_with_properties):
    """Test extracting subject with custom properties."""
    subject = mapper_with_properties.extract_subject()

    assert subject.type == "user"
    assert subject.id == "alice"
    # Custom properties should be included
    assert subject.properties["role"] == "admin"
    assert subject.properties["department"] == "eng"
    # Config properties should also be included
    assert subject.properties["user_id"] == "alice"
    assert subject.properties["session_id"] == "session-123"


def test_extract_subject_with_properties_only():
    """Test extracting subject with only custom properties, no user_id."""
    config = AuthorizationConfig(user_id=None, session_id=None)
    mapper = ContextMapper(config, subject_properties={"role": "viewer"})

    subject = mapper.extract_subject()

    assert subject.type == "user"
    assert subject.id == "claude-agent"
    assert subject.properties["role"] == "viewer"


def test_extract_resource(mapper):
    """Test extracting resource from tool."""
    tool_input = {"file_path": "/etc/passwd", "content": "secret"}

    resource = mapper.extract_resource("Write", tool_input)

    assert resource.type == "tool"
    assert resource.id == "Write"
    assert resource.properties["tool_name"] == "Write"
    # tool_input should be wrapped in {"values": ...} structure
    assert resource.properties["tool_input"]["values"]["file_path"] == "/etc/passwd"
    assert resource.properties["tool_input"]["values"]["content"] == "secret"


def test_extract_resource_no_args(mapper):
    """Test extracting resource with no arguments."""
    resource = mapper.extract_resource("Read", {})

    assert resource.type == "tool"
    assert resource.id == "Read"
    assert resource.properties["tool_name"] == "Read"
    # Empty dict should not be included
    assert "tool_input" not in resource.properties


def test_extract_resource_disable_args():
    """Test that tool_input is excluded when extract_tool_args=False."""
    config = AuthorizationConfig(extract_tool_args=False)
    mapper = ContextMapper(config)

    resource = mapper.extract_resource("Write", {"file_path": "/test"})

    assert "tool_input" not in resource.properties


def test_create_check_request(mapper):
    """Test creating a complete check request."""
    tool_input = {"file_path": "/home/user/data.txt"}

    request = mapper.create_check_request("Write", tool_input)

    # Check subject
    assert request.subject.type == "user"
    assert request.subject.id == "alice"
    assert request.subject.properties["user_id"] == "alice"
    assert request.subject.properties["session_id"] == "session-123"

    # Check resource
    assert request.resource.type == "tool"
    assert request.resource.id == "Write"
    assert request.resource.properties["tool_name"] == "Write"
    assert (
        request.resource.properties["tool_input"]["values"]["file_path"]
        == "/home/user/data.txt"
    )

    # Check action
    assert request.action.name == "create"


def test_create_check_request_read_tool():
    """Test check request for a read tool."""
    config = AuthorizationConfig(user_id="bob")
    mapper = ContextMapper(config)

    request = mapper.create_check_request("Read", {"file_path": "/var/log/app.log"})

    assert request.subject.type == "user"
    assert request.subject.id == "bob"
    assert request.resource.type == "tool"
    assert request.resource.id == "Read"
    assert request.action.name == "read"
