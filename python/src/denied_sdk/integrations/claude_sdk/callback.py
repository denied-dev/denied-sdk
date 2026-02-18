import asyncio
import logging
from typing import TYPE_CHECKING, Any

from denied_sdk import AsyncDeniedClient, CheckRequest
from denied_sdk.schemas.check import CheckResponse

from .config import AuthorizationConfig
from .context_mapper import ContextMapper

if TYPE_CHECKING:
    from claude_agent_sdk import (
        PermissionResultAllow,
        PermissionResultDeny,
        ToolPermissionContext,
    )

logger = logging.getLogger(__name__)


def create_denied_permission_callback(
    config: AuthorizationConfig | None = None,
    denied_client: AsyncDeniedClient | None = None,
    *,
    user_id: str | None = None,
    session_id: str | None = None,
    subject_properties: dict[str, Any] | None = None,
    resource_properties: dict[str, Any] | None = None,
):
    """Factory function to create a Denied authorization permission callback.

    Creates a callback function compatible with Claude Agent SDK's can_use_tool
    option. The callback performs authorization checks against the Denied service
    before allowing tool execution.

    Args:
        config: Authorization configuration. If None, uses default config
            with environment variables.
        denied_client: Optional pre-configured AsyncDeniedClient. If None,
            creates a new client from config.
        user_id: User ID for subject identification. Overrides config.user_id.
        session_id: Session ID for subject properties. Overrides config.session_id.
        subject_properties: Custom properties to include in the subject
            (e.g., {"role": "admin"}). These are merged with user_id/session_id.
        resource_properties: Custom properties to include in the resource
            (e.g., {"scope": "user"}). These are merged with tool_name/tool_input.

    Returns:
        An async callback function compatible with ClaudeAgentOptions.can_use_tool.

    Example:
        from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
        from denied_sdk.integrations.claude_sdk import create_denied_permission_callback

        # Create the callback with user context, role, and resource scope
        permission_callback = create_denied_permission_callback(
            user_id="user-123",
            subject_properties={"role": "user"},
            resource_properties={"scope": "user"},
        )

        # Use with Claude Agent SDK
        options = ClaudeAgentOptions(
            can_use_tool=permission_callback,
        )

        async with ClaudeSDKClient(options) as client:
            await client.query("List files in the current directory")
            async for message in client.receive_response():
                print(message)
    """
    # Import here to avoid circular imports and make claude_agent_sdk optional
    from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

    # Build config with overrides
    config_dict: dict[str, Any] = {}
    if config:
        config_dict = config.model_dump()

    # Apply user_id/session_id overrides
    if user_id is not None:
        config_dict["user_id"] = user_id
    if session_id is not None:
        config_dict["session_id"] = session_id

    effective_config = (
        AuthorizationConfig(**config_dict) if config_dict else AuthorizationConfig()
    )

    # Store properties for the mapper
    effective_subject_properties = subject_properties or {}
    effective_resource_properties = resource_properties or {}

    # Create client if not provided
    client = denied_client or AsyncDeniedClient(
        url=effective_config.denied_url,
        api_key=effective_config.denied_api_key,
        timeout=effective_config.timeout_seconds,
    )

    mapper = ContextMapper(
        effective_config,
        effective_subject_properties,
        effective_resource_properties,
    )

    logger.info(
        f"Created Denied authorization callback: url={effective_config.denied_url}, "
        f"fail_mode={effective_config.fail_mode}, "
        f"user_id={effective_config.user_id}"
    )

    async def denied_permission_callback(
        tool_name: str,
        input_data: dict[str, Any],
        context: "ToolPermissionContext",
    ) -> "PermissionResultAllow | PermissionResultDeny":
        """Permission callback that checks authorization via Denied service.

        Args:
            tool_name: Name of the tool being invoked.
            input_data: Arguments passed to the tool.
            context: Tool permission context from Claude SDK.

        Returns:
            PermissionResultAllow to allow tool execution, or
            PermissionResultDeny to block execution with a reason.
        """
        logger.debug(
            f"Checking authorization for tool={tool_name}, "
            f"user={effective_config.user_id}"
        )

        # Build authorization request
        check_request = mapper.create_check_request(tool_name, input_data)

        logger.debug(
            f"Authorization check request: "
            f"subject={check_request.subject.model_dump()}, "
            f"resource={check_request.resource.model_dump()}, "
            f"action={check_request.action.model_dump()}"
        )

        # Perform authorization check with retry
        check_result = await _check_with_retry(client, check_request, effective_config)

        # Handle service unavailability
        if check_result is None:
            logger.warning(
                f"Authorization service unavailable for tool={tool_name}, "
                f"fail_mode={effective_config.fail_mode}"
            )
            if effective_config.fail_mode == "closed":
                return PermissionResultDeny(
                    message="Authorization service unavailable (fail-closed mode)"
                )
            # Fail open - allow execution
            logger.warning(f"Allowing tool={tool_name} execution in fail-open mode")
            return PermissionResultAllow()

        # Handle authorization decision
        if not check_result.decision:
            logger.info(
                f"Authorization DENIED for tool={tool_name}, "
                f"user={effective_config.user_id}, "
                f"reason={check_result.context.reason}"
            )
            return PermissionResultDeny(
                message=check_result.context.reason or "Authorization denied"
            )

        logger.debug(
            f"Authorization ALLOWED for tool={tool_name}, "
            f"user={effective_config.user_id}"
        )
        return PermissionResultAllow()

    return denied_permission_callback


async def _check_with_retry(
    client: AsyncDeniedClient,
    check_request: CheckRequest,
    config: AuthorizationConfig,
) -> CheckResponse | None:
    """Perform authorization check with retry logic.

    Args:
        client: The async Denied client.
        check_request: The authorization check request.
        config: Authorization configuration.

    Returns:
        CheckResponse if successful, None if all retries failed.
    """
    for attempt in range(config.retry_attempts + 1):
        try:
            return await client.check(
                subject=check_request.subject,
                action=check_request.action,
                resource=check_request.resource,
                context=check_request.context,
            )

        except Exception as e:
            is_final_attempt = attempt == config.retry_attempts

            if is_final_attempt:
                logger.error(
                    f"Authorization check failed after {attempt + 1} attempts: {e}"
                )
                return None
            # Exponential backoff: 0.1s, 0.2s, 0.4s, ...
            backoff_seconds = (2**attempt) * 0.1
            logger.warning(
                f"Authorization check failed (attempt {attempt + 1}), "
                f"retrying in {backoff_seconds}s: {e}"
            )
            await asyncio.sleep(backoff_seconds)

    return None
