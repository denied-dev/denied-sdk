from typing import Any

from denied_sdk.enums.entity import EntityType
from denied_sdk.integrations.shared import extract_action
from denied_sdk.schemas.check import CheckRequest, PrincipalCheck, ResourceCheck

from .config import AuthorizationConfig


class ContextMapper:
    """Maps Claude Agent SDK tool execution context to Denied authorization model.

    This class extracts relevant context from Claude SDK's tool permission callback
    parameters to construct authorization requests for the Denied service.

    Args:
        config: Authorization configuration controlling what context to extract.
        principal_attributes: Custom attributes to include in the principal
            (e.g., {"role": "admin"}).
        resource_attributes: Custom attributes to include in the resource
            (e.g., {"scope": "user"}).

    Example:
        mapper = ContextMapper(config, {"role": "admin"}, {"scope": "user"})
        request = mapper.create_check_request(tool_name, input_data)
    """

    def __init__(
        self,
        config: AuthorizationConfig,
        principal_attributes: dict[str, Any] | None = None,
        resource_attributes: dict[str, Any] | None = None,
    ):
        """Initialize the context mapper.

        Args:
            config: Configuration controlling context extraction.
            principal_attributes: Custom attributes to include in the principal.
            resource_attributes: Custom attributes to include in the resource.
        """
        self.config = config
        self.principal_attributes = principal_attributes or {}
        self.resource_attributes = resource_attributes or {}

    def extract_principal(self) -> PrincipalCheck:
        """Extract principal information from configuration.

        Since Claude Agent SDK's can_use_tool callback doesn't provide user context
        directly, principal information is captured at callback creation time via
        the factory pattern.

        Returns:
            PrincipalCheck with URI and attributes for the principal.
        """
        # Start with custom principal attributes (e.g., role, scope)
        attributes: dict[str, Any] = dict(self.principal_attributes)

        # Add user_id and session_id if provided
        if self.config.user_id:
            attributes["user_id"] = self.config.user_id

        if self.config.session_id:
            attributes["session_id"] = self.config.session_id

        # Build principal URI
        principal_id = self.config.user_id or "claude-agent"
        principal_uri = f"user:{principal_id}"

        return PrincipalCheck(
            type=EntityType.principal,
            uri=principal_uri,
            attributes=attributes if attributes else None,
        )

    def extract_resource(
        self, tool_name: str, tool_input: dict[str, Any]
    ) -> ResourceCheck:
        """Extract resource information from tool and arguments.

        Args:
            tool_name: Name of the tool being invoked.
            tool_input: Arguments passed to the tool.

        Returns:
            ResourceCheck with URI and attributes for the resource.
        """
        # Start with custom resource attributes (e.g., scope)
        attributes: dict[str, Any] = dict(self.resource_attributes)

        # Add tool name
        attributes["tool_name"] = tool_name

        # Add tool input if configured (aligned with ADK structure)
        if self.config.extract_tool_args and tool_input:
            attributes["tool_input"] = {"values": tool_input}

        # Build resource URI
        resource_uri = f"tool:{tool_name}"

        return ResourceCheck(
            type=EntityType.resource,
            uri=resource_uri,
            attributes=attributes,
        )

    def create_check_request(
        self,
        tool_name: str,
        tool_input: dict[str, Any],
    ) -> CheckRequest:
        """Create a complete authorization check request.

        Args:
            tool_name: Name of the tool being invoked.
            tool_input: Arguments passed to the tool.

        Returns:
            CheckRequest ready to send to Denied service.
        """
        principal = self.extract_principal()
        resource = self.extract_resource(tool_name, tool_input)
        # Pass tool_input for Bash command analysis
        action = extract_action(tool_name, tool_input)

        return CheckRequest(
            principal=principal,
            resource=resource,
            action=action,
        )
