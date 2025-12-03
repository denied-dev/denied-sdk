import asyncio
import logging
from typing import TYPE_CHECKING, Any

from google.adk.plugins.base_plugin import BasePlugin

from denied_sdk import AsyncDeniedClient
from denied_sdk.schemas.check import CheckResponse

from .config import AuthorizationConfig
from .context_mapper import ContextMapper

if TYPE_CHECKING:
    from google.adk.tools.base_tool import BaseTool
    from google.adk.tools.tool_context import ToolContext

logger = logging.getLogger(__name__)


class AuthorizationPlugin(BasePlugin):
    """ADK plugin that enforces authorization via Denied service.

    This plugin intercepts tool calls before execution and performs
    authorization checks against the Denied service. If authorization
    is denied, the tool execution is blocked.

    Args:
        config: Authorization configuration. If None, uses default config
            with environment variables.
        denied_client: Optional pre-configured AsyncDeniedClient. If None,
            creates a new client from config.

    Example:
        # Zero-config setup
        plugin = AuthorizationPlugin()
        runner = Runner(agent=agent, plugins=[plugin])

        # Custom configuration
        config = AuthorizationConfig(
            denied_url="https://auth.company.com",
            fail_mode="closed",
        )
        plugin = AuthorizationPlugin(config)
        runner = Runner(agent=agent, plugins=[plugin])
    """

    def __init__(
        self,
        config: AuthorizationConfig | None = None,
        denied_client: AsyncDeniedClient | None = None,
    ):
        """Initialize the authorization plugin.

        Args:
            config: Configuration for authorization behavior.
            denied_client: Optional pre-configured client for testing.
        """
        super().__init__(name="denied_authorization")

        self.config = config or AuthorizationConfig()

        self.client = denied_client or AsyncDeniedClient(
            url=self.config.denied_url,
            api_key=self.config.denied_api_key,
            timeout=self.config.timeout_seconds,
        )

        self.mapper = ContextMapper(self.config)

        logger.info(
            f"Initialized Denied authorization plugin: url={self.config.denied_url}, "
            f"fail_mode={self.config.fail_mode}"
        )

    async def before_tool_callback(
        self,
        *,
        tool: "BaseTool",
        tool_args: dict[str, Any],
        tool_context: "ToolContext",
    ) -> dict | None:
        """Intercept tool execution to perform authorization check.

        This callback is invoked by ADK before a tool is executed. It performs
        an authorization check against the Denied service and either allows
        execution to proceed (by returning None) or blocks it (by returning
        an error dictionary).

        Args:
            tool: The tool being invoked.
            tool_args: Arguments passed to the tool.
            tool_context: ADK tool execution context.

        Returns:
            None to allow tool execution, or a dict with an error message
            to block execution.
        """
        logger.debug(
            f"Checking authorization for tool={tool.name}, "
            f"user={tool_context.user_id}, "
            f"session={tool_context.session.id}"
        )

        # Build authorization request from ADK context
        check_request = self.mapper.create_check_request(tool, tool_args, tool_context)

        # Debug: Log the check request
        logger.debug(
            f"Authorization check request: "
            f"principal={check_request.principal.model_dump()}, "
            f"resource={check_request.resource.model_dump()}, "
            f"action={check_request.action}"
        )

        # Perform authorization check with retry
        check_result = await self._check_with_retry(check_request)

        # Handle service unavailability
        if check_result is None:
            logger.warning(
                f"Authorization service unavailable for tool={tool.name}, "
                f"fail_mode={self.config.fail_mode}"
            )
            if self.config.fail_mode == "closed":
                return self._create_denial_response(
                    "Authorization service unavailable (fail-closed mode)"
                )
            # Fail open - allow execution
            logger.warning(f"Allowing tool={tool.name} execution in fail-open mode")
            return None

        # Handle authorization decision
        if not check_result.allowed:
            logger.info(
                f"Authorization DENIED for tool={tool.name}, "
                f"user={tool_context.user_id}, "
                f"reason={check_result.reason}"
            )
            return self._create_denial_response(check_result.reason)

        logger.debug(
            f"Authorization ALLOWED for tool={tool.name}, user={tool_context.user_id}"
        )
        return None  # Allow execution

    async def _check_with_retry(self, check_request) -> CheckResponse | None:
        """Perform authorization check with retry logic.

        Args:
            check_request: The authorization check request.

        Returns:
            CheckResponse if successful, None if all retries failed.
        """
        for attempt in range(self.config.retry_attempts + 1):
            try:
                return await self.client.check(
                    principal_uri=check_request.principal.uri,
                    principal_attributes=check_request.principal.attributes,
                    resource_uri=check_request.resource.uri,
                    resource_attributes=check_request.resource.attributes,
                    action=check_request.action,
                )

            except Exception as e:
                is_final_attempt = attempt == self.config.retry_attempts

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

    def _create_denial_response(self, reason: str | None) -> dict:
        """Create a response dict to block tool execution.

        Args:
            reason: Reason for denial.

        Returns:
            Dictionary that ADK will use as the tool response.
        """
        message = (
            f"Authorization denied: {reason}" if reason else "Authorization denied"
        )
        return {
            "error": message,
            "denied": True,
        }

    async def close(self) -> None:
        """Clean up resources when the plugin is closed.

        This is called by ADK when the runner is shut down.
        """
        logger.info("Closing Denied authorization plugin")
        await self.client.close()
