"""Tests for AuthorizationPlugin."""

from unittest.mock import AsyncMock, Mock

import pytest

from denied_sdk.schemas.check import CheckResponse
from integrations.adk.async_client import AsyncDeniedClient
from integrations.adk.config import AuthorizationConfig
from integrations.adk.plugin import AuthorizationPlugin


@pytest.fixture
def config():
    """Create test configuration."""
    return AuthorizationConfig(
        denied_url="http://localhost:8421",
        denied_api_key="test-key",
        fail_mode="closed",
        retry_attempts=2,
    )


@pytest.fixture
def mock_client():
    """Create a mock async client."""
    return AsyncMock(spec=AsyncDeniedClient)


@pytest.fixture
def mock_tool():
    """Create a mock tool."""
    tool = Mock()
    tool.name = "write_file"
    tool.description = "Write to a file"
    tool.custom_metadata = None
    return tool


@pytest.fixture
def mock_tool_context():
    """Create a mock tool context."""
    context = Mock()
    context.user_id = "alice"
    context.agent_name = "file_agent"
    context.session.id = "session-123"
    context.invocation_id = "inv-456"
    context.state = {"role": "admin"}
    return context


@pytest.mark.asyncio
async def test_plugin_allows_authorized_call(
    config, mock_client, mock_tool, mock_tool_context
):
    """Test plugin allows execution when authorized."""
    mock_client.check.return_value = CheckResponse(allowed=True, reason=None, rules=[])

    plugin = AuthorizationPlugin(config=config, denied_client=mock_client)

    result = await plugin.before_tool_callback(
        tool=mock_tool,
        tool_args={"file_path": "/tmp/test.txt"},
        tool_context=mock_tool_context,
    )

    assert result is None  # None means allow execution
    mock_client.check.assert_called_once()


@pytest.mark.asyncio
async def test_plugin_denies_unauthorized_call(
    config, mock_client, mock_tool, mock_tool_context
):
    """Test plugin blocks execution when denied."""
    mock_client.check.return_value = CheckResponse(
        allowed=False,
        reason="Insufficient permissions",
        rules=["policy-123"],
    )

    plugin = AuthorizationPlugin(config=config, denied_client=mock_client)

    result = await plugin.before_tool_callback(
        tool=mock_tool,
        tool_args={"file_path": "/etc/passwd"},
        tool_context=mock_tool_context,
    )

    assert result is not None  # Non-None means block execution
    assert result["denied"] is True
    assert "Insufficient permissions" in result["error"]


@pytest.mark.asyncio
async def test_plugin_fail_closed_mode(
    config, mock_client, mock_tool, mock_tool_context
):
    """Test plugin denies when service is unavailable in fail-closed mode."""
    mock_client.check.side_effect = Exception("Service unavailable")

    config.fail_mode = "closed"
    plugin = AuthorizationPlugin(config=config, denied_client=mock_client)

    result = await plugin.before_tool_callback(
        tool=mock_tool,
        tool_args={},
        tool_context=mock_tool_context,
    )

    assert result is not None
    assert result["denied"] is True
    assert "unavailable" in result["error"].lower()


@pytest.mark.asyncio
async def test_plugin_fail_open_mode(config, mock_client, mock_tool, mock_tool_context):
    """Test plugin allows when service is unavailable in fail-open mode."""
    mock_client.check.side_effect = Exception("Service unavailable")

    config.fail_mode = "open"
    plugin = AuthorizationPlugin(config=config, denied_client=mock_client)

    result = await plugin.before_tool_callback(
        tool=mock_tool,
        tool_args={},
        tool_context=mock_tool_context,
    )

    assert result is None  # Allow execution in fail-open mode


@pytest.mark.asyncio
async def test_plugin_retry_logic(config, mock_client, mock_tool, mock_tool_context):
    """Test plugin retries on failure."""
    # Fail first 2 times, succeed on 3rd
    mock_client.check.side_effect = [
        Exception("Timeout"),
        Exception("Timeout"),
        CheckResponse(allowed=True, reason=None, rules=[]),
    ]

    config.retry_attempts = 2  # Will try 3 times total (initial + 2 retries)
    plugin = AuthorizationPlugin(config=config, denied_client=mock_client)

    result = await plugin.before_tool_callback(
        tool=mock_tool,
        tool_args={},
        tool_context=mock_tool_context,
    )

    assert result is None  # Eventually succeeded
    assert mock_client.check.call_count == 3


@pytest.mark.asyncio
async def test_plugin_retry_exhausted(
    config, mock_client, mock_tool, mock_tool_context
):
    """Test plugin denies when retries are exhausted."""
    mock_client.check.side_effect = Exception("Service error")

    config.retry_attempts = 2
    config.fail_mode = "closed"
    plugin = AuthorizationPlugin(config=config, denied_client=mock_client)

    result = await plugin.before_tool_callback(
        tool=mock_tool,
        tool_args={},
        tool_context=mock_tool_context,
    )

    assert result is not None
    assert result["denied"] is True
    assert mock_client.check.call_count == 3  # Initial + 2 retries


@pytest.mark.asyncio
async def test_plugin_close(config, mock_client):
    """Test plugin cleanup."""
    plugin = AuthorizationPlugin(config=config, denied_client=mock_client)

    await plugin.close()

    mock_client.close.assert_called_once()


def test_plugin_default_config():
    """Test plugin initialization with default config."""
    # This will use environment variables or defaults
    plugin = AuthorizationPlugin()

    assert plugin.config is not None
    assert plugin.client is not None
    assert plugin.mapper is not None
    assert plugin.name == "denied_authorization"
