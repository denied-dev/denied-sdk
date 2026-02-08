"""Tests for the permission callback."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from denied_sdk import AsyncDeniedClient
from denied_sdk.integrations.claude_sdk.callback import (
    create_denied_permission_callback,
)
from denied_sdk.integrations.claude_sdk.config import AuthorizationConfig
from denied_sdk.schemas.check import CheckResponse


@pytest.fixture
def config():
    """Create test configuration."""
    return AuthorizationConfig(
        denied_url="http://localhost:8421",
        denied_api_key="test-key",
        fail_mode="closed",
        retry_attempts=2,
        user_id="alice",
        session_id="session-123",
    )


@pytest.fixture
def mock_client():
    """Create a mock async client."""
    return AsyncMock(spec=AsyncDeniedClient)


@pytest.fixture
def mock_context():
    """Create a mock ToolPermissionContext."""
    context = MagicMock()
    context.signal = None
    context.suggestions = []
    return context


@pytest.mark.asyncio
async def test_callback_allows_authorized_call(config, mock_client, mock_context):
    """Test callback allows execution when authorized."""
    mock_client.check.return_value = CheckResponse(allowed=True, reason=None, rules=[])

    callback = create_denied_permission_callback(
        config=config,
        denied_client=mock_client,
    )

    result = await callback("Write", {"file_path": "/tmp/test.txt"}, mock_context)

    assert result.behavior == "allow"
    mock_client.check.assert_called_once()


@pytest.mark.asyncio
async def test_callback_denies_unauthorized_call(config, mock_client, mock_context):
    """Test callback blocks execution when denied."""
    mock_client.check.return_value = CheckResponse(
        allowed=False,
        reason="Insufficient permissions",
        rules=["policy-123"],
    )

    callback = create_denied_permission_callback(
        config=config,
        denied_client=mock_client,
    )

    result = await callback("Write", {"file_path": "/etc/passwd"}, mock_context)

    assert result.behavior == "deny"
    assert result.message == "Insufficient permissions"


@pytest.mark.asyncio
async def test_callback_fail_closed_mode(config, mock_client, mock_context):
    """Test callback denies when service is unavailable in fail-closed mode."""
    mock_client.check.side_effect = Exception("Service unavailable")

    config.fail_mode = "closed"
    callback = create_denied_permission_callback(
        config=config,
        denied_client=mock_client,
    )

    result = await callback("Write", {}, mock_context)

    assert result.behavior == "deny"
    assert "unavailable" in result.message.lower()


@pytest.mark.asyncio
async def test_callback_fail_open_mode(config, mock_client, mock_context):
    """Test callback allows when service is unavailable in fail-open mode."""
    mock_client.check.side_effect = Exception("Service unavailable")

    config.fail_mode = "open"
    callback = create_denied_permission_callback(
        config=config,
        denied_client=mock_client,
    )

    result = await callback("Write", {}, mock_context)

    assert result.behavior == "allow"


@pytest.mark.asyncio
async def test_callback_retry_logic(config, mock_client, mock_context):
    """Test callback retries on failure."""
    # Fail first 2 times, succeed on 3rd
    mock_client.check.side_effect = [
        Exception("Timeout"),
        Exception("Timeout"),
        CheckResponse(allowed=True, reason=None, rules=[]),
    ]

    config.retry_attempts = 2  # Will try 3 times total (initial + 2 retries)
    callback = create_denied_permission_callback(
        config=config,
        denied_client=mock_client,
    )

    result = await callback("Write", {}, mock_context)

    assert result.behavior == "allow"
    assert mock_client.check.call_count == 3


@pytest.mark.asyncio
async def test_callback_retry_exhausted(config, mock_client, mock_context):
    """Test callback denies when retries are exhausted."""
    mock_client.check.side_effect = Exception("Service error")

    config.retry_attempts = 2
    config.fail_mode = "closed"
    callback = create_denied_permission_callback(
        config=config,
        denied_client=mock_client,
    )

    result = await callback("Write", {}, mock_context)

    assert result.behavior == "deny"
    assert mock_client.check.call_count == 3  # Initial + 2 retries


@pytest.mark.asyncio
async def test_callback_user_id_override(config, mock_client, mock_context):
    """Test user_id can be overridden at callback creation."""
    mock_client.check.return_value = CheckResponse(allowed=True, reason=None, rules=[])

    callback = create_denied_permission_callback(
        config=config,
        denied_client=mock_client,
        user_id="bob",  # Override config's user_id
    )

    await callback("Read", {}, mock_context)

    # Verify the call was made with bob as the user
    call_args = mock_client.check.call_args
    assert "bob" in call_args.kwargs["principal_uri"]


@pytest.mark.asyncio
async def test_callback_session_id_override(config, mock_client, mock_context):
    """Test session_id can be overridden at callback creation."""
    mock_client.check.return_value = CheckResponse(allowed=True, reason=None, rules=[])

    callback = create_denied_permission_callback(
        config=config,
        denied_client=mock_client,
        session_id="new-session",  # Override config's session_id
    )

    await callback("Read", {}, mock_context)

    # Verify the call was made with new-session
    call_args = mock_client.check.call_args
    assert call_args.kwargs["principal_attributes"]["session_id"] == "new-session"


@pytest.mark.asyncio
async def test_callback_principal_attributes(config, mock_client, mock_context):
    """Test principal_attributes are passed to authorization check."""
    mock_client.check.return_value = CheckResponse(allowed=True, reason=None, rules=[])

    callback = create_denied_permission_callback(
        config=config,
        denied_client=mock_client,
        principal_attributes={"role": "admin", "department": "engineering"},
    )

    await callback("Write", {}, mock_context)

    call_args = mock_client.check.call_args
    principal_attrs = call_args.kwargs["principal_attributes"]
    assert principal_attrs["role"] == "admin"
    assert principal_attrs["department"] == "engineering"
    # user_id and session_id from config should also be present
    assert principal_attrs["user_id"] == "alice"
    assert principal_attrs["session_id"] == "session-123"


@pytest.mark.asyncio
async def test_callback_principal_attributes_without_user_id(mock_client, mock_context):
    """Test principal_attributes work without user_id."""
    mock_client.check.return_value = CheckResponse(allowed=True, reason=None, rules=[])

    config = AuthorizationConfig(
        denied_url="http://localhost:8421",
        denied_api_key="test-key",
    )

    callback = create_denied_permission_callback(
        config=config,
        denied_client=mock_client,
        principal_attributes={"role": "viewer"},
    )

    await callback("Read", {}, mock_context)

    call_args = mock_client.check.call_args
    principal_attrs = call_args.kwargs["principal_attributes"]
    assert principal_attrs["role"] == "viewer"
    # user_id not in config, so should not be present
    assert "user_id" not in principal_attrs


@pytest.mark.asyncio
async def test_callback_with_tool_args(config, mock_client, mock_context):
    """Test callback passes tool arguments to authorization check."""
    mock_client.check.return_value = CheckResponse(allowed=True, reason=None, rules=[])

    callback = create_denied_permission_callback(
        config=config,
        denied_client=mock_client,
    )

    await callback(
        "Write",
        {"file_path": "/home/alice/doc.txt", "content": "hello"},
        mock_context,
    )

    call_args = mock_client.check.call_args
    resource_attrs = call_args.kwargs["resource_attributes"]
    # tool_input should be wrapped in {"values": ...} structure
    assert resource_attrs["tool_input"]["values"]["file_path"] == "/home/alice/doc.txt"
    assert resource_attrs["tool_input"]["values"]["content"] == "hello"


@pytest.mark.asyncio
async def test_callback_action_inference(config, mock_client, mock_context):
    """Test callback infers correct action from tool name."""
    mock_client.check.return_value = CheckResponse(allowed=True, reason=None, rules=[])

    callback = create_denied_permission_callback(
        config=config,
        denied_client=mock_client,
    )

    # Test Read tool -> read action
    await callback("Read", {}, mock_context)
    assert mock_client.check.call_args.kwargs["action"] == "read"

    # Test Write tool -> create action
    mock_client.check.reset_mock()
    await callback("Write", {}, mock_context)
    assert mock_client.check.call_args.kwargs["action"] == "create"

    # Test Edit tool -> update action
    mock_client.check.reset_mock()
    await callback("Edit", {}, mock_context)
    assert mock_client.check.call_args.kwargs["action"] == "update"

    # Test Bash tool -> execute action
    mock_client.check.reset_mock()
    await callback("Bash", {}, mock_context)
    assert mock_client.check.call_args.kwargs["action"] == "execute"


def test_callback_default_config():
    """Test callback creation with default config from env vars."""
    # This will use environment variables or defaults
    callback = create_denied_permission_callback()

    assert callback is not None
    assert callable(callback)
