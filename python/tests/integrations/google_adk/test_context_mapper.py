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
    assert resource.attributes["scope"] == "user"  # Extracted from session state
    # All tool args should be in tool_input.values
    assert "tool_input" in resource.attributes
    assert resource.attributes["tool_input"]["values"]["file_path"] == "/etc/passwd"
    assert resource.attributes["tool_input"]["values"]["content"] == "secret"


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


def test_extract_resource_all_args_captured(mapper, mock_tool, mock_tool_context):
    """Test that all tool arguments are captured in tool_input.values."""
    tool_args = {
        "resource_id": "res-123",
        "document_id": "doc-456",
        "path": "/var/log/app.log",
        "custom_arg": "also-captured",
    }

    resource = mapper.extract_resource(mock_tool, tool_args, mock_tool_context)

    # All args should be in tool_input.values
    values = resource.attributes["tool_input"]["values"]
    assert values["resource_id"] == "res-123"
    assert values["document_id"] == "doc-456"
    assert values["path"] == "/var/log/app.log"
    assert values["custom_arg"] == "also-captured"


def test_extract_resource_with_mcp_schema(mapper, mock_tool_context):
    """Test extracting resource with MCP tool schema."""
    tool = Mock()
    tool.name = "mcp_tool"
    tool.description = "MCP tool"
    tool.custom_metadata = None
    tool.raw_mcp_tool = Mock()
    tool.raw_mcp_tool.inputSchema = {
        "type": "object",
        "properties": {"query": {"type": "string"}},
    }

    tool_args = {"query": "test search"}
    resource = mapper.extract_resource(tool, tool_args, mock_tool_context)

    # Should have both schema and values in tool_input
    assert "tool_input" in resource.attributes
    assert resource.attributes["tool_input"]["schema"] == {
        "type": "object",
        "properties": {"query": {"type": "string"}},
    }
    assert resource.attributes["tool_input"]["values"] == {"query": "test search"}


def test_extract_resource_with_function_schema(mapper, mock_tool_context):
    """Test extracting resource with function tool schema."""

    def sample_func(name: str, count: int = 10) -> str:
        return f"{name}: {count}"

    tool = Mock()
    tool.name = "function_tool"
    tool.description = "Function tool"
    tool.custom_metadata = None
    tool.func = sample_func
    # Ensure raw_mcp_tool is not present
    del tool.raw_mcp_tool

    tool_args = {"name": "test", "count": 5}
    resource = mapper.extract_resource(tool, tool_args, mock_tool_context)

    # Should have schema extracted from function signature
    assert "tool_input" in resource.attributes
    schema = resource.attributes["tool_input"]["schema"]
    assert "name" in schema
    assert schema["name"]["type"] == "str"
    assert schema["name"]["required"] is True
    assert "count" in schema
    assert schema["count"]["type"] == "int"
    assert schema["count"]["required"] is False
    assert schema["count"]["default"] == 10
    # Values should be captured
    assert resource.attributes["tool_input"]["values"] == {"name": "test", "count": 5}


def test_create_check_request(mapper, mock_tool, mock_tool_context):
    """Test creating a complete check request."""
    tool_args = {"file_path": "/home/user/data.txt"}

    request = mapper.create_check_request(mock_tool, tool_args, mock_tool_context)

    # Check principal
    assert request.principal.uri == "user:alice"
    assert request.principal.attributes["role"] == "user"

    # Check resource
    assert request.resource.uri == "tool:write_file"
    assert (
        request.resource.attributes["tool_input"]["values"]["file_path"]
        == "/home/user/data.txt"
    )
    assert request.resource.attributes["scope"] == "user"

    # Check action
    assert request.action == "create"


def test_config_disable_tool_args():
    """Test disabling tool args extraction via config."""
    config = AuthorizationConfig(
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

    # Test tool_input not included when extract_tool_args is False
    tool = Mock()
    tool.name = "test_tool"
    tool.description = "Test"
    tool.custom_metadata = None

    resource = mapper.extract_resource(tool, {"file_path": "/test"}, context)
    assert "tool_input" not in resource.attributes
