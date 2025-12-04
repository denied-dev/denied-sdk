"""Tests for ContextMapper."""

from unittest.mock import Mock

import pytest

from denied_sdk.integrations.google_adk.config import AuthorizationConfig
from denied_sdk.integrations.google_adk.context_mapper import ContextMapper


@pytest.fixture
def config():
    """Create a config with state key extraction."""
    return AuthorizationConfig(
        principal_state_keys=["role"],
        resource_state_keys=["scope"],
    )


@pytest.fixture
def mapper(config):
    """Create a context mapper."""
    return ContextMapper(config)


@pytest.fixture
def mock_tool_context():
    """Create a mock ToolContext."""
    context = Mock()
    context.user_id = "alice"
    context.agent_name = "file_agent"
    context.session.id = "session-123"
    context.invocation_id = "invocation-456"
    context.state = Mock()
    context.state.to_dict = Mock(return_value={"role": "user", "scope": "user"})
    return context


@pytest.fixture
def mock_tool():
    """Create a mock tool."""
    tool = Mock()
    tool.name = "write_file"
    tool.description = "Write content to a file"
    tool.custom_metadata = None
    return tool


def test_extract_principal(mapper, mock_tool_context):
    """Test extracting principal from tool context."""
    principal = mapper.extract_principal(mock_tool_context)

    assert principal.uri == "user:alice"
    assert principal.attributes["user_id"] == "alice"
    assert principal.attributes["agent_name"] == "file_agent"
    assert principal.attributes["session_id"] == "session-123"
    assert principal.attributes["invocation_id"] == "invocation-456"
    assert principal.attributes["role"] == "user"
    # scope is a resource attribute, not principal
    assert "scope" not in principal.attributes


def test_extract_principal_no_state_keys(mapper):
    """Test extracting principal without configured state keys present."""
    context = Mock()
    context.user_id = "bob"
    context.agent_name = "api_agent"
    context.session.id = "session-789"
    context.invocation_id = "invocation-012"
    context.state = Mock()
    context.state.to_dict = Mock(return_value={})  # No role in state

    principal = mapper.extract_principal(context)

    assert principal.uri == "user:bob"
    assert "role" not in principal.attributes


def test_extract_resource(mapper, mock_tool, mock_tool_context):
    """Test extracting resource from tool."""
    tool_args = {"file_path": "/etc/passwd", "content": "secret"}

    resource = mapper.extract_resource(mock_tool, tool_args, mock_tool_context)

    assert resource.uri == "tool:write_file"
    assert resource.attributes["tool_name"] == "write_file"
    assert resource.attributes["tool_description"] == "Write content to a file"
    assert resource.attributes["file_path"] == "/etc/passwd"
    assert resource.attributes["scope"] == "user"  # Extracted from session state
    # content should not be extracted (not in resource_arg_names)


def test_extract_resource_with_metadata(mapper, mock_tool_context):
    """Test extracting resource with custom metadata."""
    tool = Mock()
    tool.name = "api_call"
    tool.description = "Call external API"
    tool.custom_metadata = {"api_version": "v2", "auth_required": True}

    resource = mapper.extract_resource(tool, {}, mock_tool_context)

    assert resource.uri == "tool:api_call"
    assert resource.attributes["api_version"] == "v2"
    assert resource.attributes["auth_required"] is True


def test_extract_resource_various_args(mapper, mock_tool, mock_tool_context):
    """Test extracting different resource argument names."""
    tool_args = {
        "resource_id": "res-123",
        "document_id": "doc-456",
        "path": "/var/log/app.log",
        "other_arg": "not-extracted",
    }

    resource = mapper.extract_resource(mock_tool, tool_args, mock_tool_context)

    assert resource.attributes["resource_id"] == "res-123"
    assert resource.attributes["document_id"] == "doc-456"
    assert resource.attributes["path"] == "/var/log/app.log"
    assert "other_arg" not in resource.attributes


def test_extract_action_read_pattern(mapper):
    """Test action extraction for read verbs."""
    tool = Mock()

    tool.name = "read_file"
    assert mapper.extract_action(tool) == "read"

    tool.name = "get_user"
    assert mapper.extract_action(tool) == "read"

    tool.name = "fetch_data"
    assert mapper.extract_action(tool) == "read"

    tool.name = "list_items"
    assert mapper.extract_action(tool) == "read"


def test_extract_action_write_pattern(mapper):
    """Test action extraction for write verbs."""
    tool = Mock()

    tool.name = "write_file"
    assert mapper.extract_action(tool) == "create"

    tool.name = "create_user"
    assert mapper.extract_action(tool) == "create"

    tool.name = "add_item"
    assert mapper.extract_action(tool) == "create"


def test_extract_action_update_pattern(mapper):
    """Test action extraction for update verbs."""
    tool = Mock()

    tool.name = "update_record"
    assert mapper.extract_action(tool) == "update"

    tool.name = "modify_settings"
    assert mapper.extract_action(tool) == "update"

    tool.name = "edit_document"
    assert mapper.extract_action(tool) == "update"


def test_extract_action_delete_pattern(mapper):
    """Test action extraction for delete verbs."""
    tool = Mock()

    tool.name = "delete_file"
    assert mapper.extract_action(tool) == "delete"

    tool.name = "remove_user"
    assert mapper.extract_action(tool) == "delete"


def test_extract_action_execute_pattern(mapper):
    """Test action extraction for execute verbs."""
    tool = Mock()

    tool.name = "execute_command"
    assert mapper.extract_action(tool) == "execute"

    tool.name = "run_script"
    assert mapper.extract_action(tool) == "execute"


def test_extract_action_no_match(mapper):
    """Test action extraction when no pattern matches."""
    tool = Mock()

    tool.name = "calculate_total"
    assert mapper.extract_action(tool) == "execute"

    tool.name = "process_data"
    assert mapper.extract_action(tool) == "execute"


def test_create_check_request(mapper, mock_tool, mock_tool_context):
    """Test creating a complete check request."""
    tool_args = {"file_path": "/home/user/data.txt"}

    request = mapper.create_check_request(mock_tool, tool_args, mock_tool_context)

    # Check principal
    assert request.principal.uri == "user:alice"
    assert request.principal.attributes["role"] == "user"

    # Check resource
    assert request.resource.uri == "tool:write_file"
    assert request.resource.attributes["file_path"] == "/home/user/data.txt"
    assert request.resource.attributes["scope"] == "user"

    # Check action
    assert request.action == "create"


def test_config_disable_extractions():
    """Test disabling context extractions via config."""
    config = AuthorizationConfig(
        include_user_id=False,
        include_agent_name=False,
        include_session_id=False,
        extract_tool_args=False,
    )
    mapper = ContextMapper(config)

    context = Mock()
    context.user_id = "alice"
    context.agent_name = "agent"
    context.session.id = "session-123"
    context.invocation_id = "inv-456"
    context.state = Mock()
    context.state.to_dict = Mock(return_value={})

    principal = mapper.extract_principal(context)

    # Should only have invocation_id (always included)
    assert "user_id" not in principal.attributes
    assert "agent_name" not in principal.attributes
    assert "session_id" not in principal.attributes
    assert "invocation_id" in principal.attributes  # Always included

    # Test tool args not extracted
    tool = Mock()
    tool.name = "test_tool"
    tool.description = "Test"
    tool.custom_metadata = None

    resource = mapper.extract_resource(tool, {"file_path": "/test"}, context)
    assert "file_path" not in resource.attributes
