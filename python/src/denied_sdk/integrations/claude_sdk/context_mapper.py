from typing import Any

from denied_sdk.integrations.shared import extract_action
from denied_sdk.schemas.check import Action, CheckRequest, Resource, Subject

from .config import AuthorizationConfig


class ContextMapper:
    """Maps Claude Agent SDK tool execution context to Denied authorization model.

    This class extracts relevant context from Claude SDK's tool permission callback
    parameters to construct authorization requests for the Denied service.

    Args:
        config: Authorization configuration controlling what context to extract.
        subject_properties: Custom properties to include in the subject
            (e.g., {"role": "admin"}).
        resource_properties: Custom properties to include in the resource
            (e.g., {"scope": "user"}).

    Example:
        mapper = ContextMapper(config, {"role": "admin"}, {"scope": "user"})
        request = mapper.create_check_request(tool_name, input_data)
    """

    def __init__(
        self,
        config: AuthorizationConfig,
        subject_properties: dict[str, Any] | None = None,
        resource_properties: dict[str, Any] | None = None,
    ):
        """Initialize the context mapper.

        Args:
            config: Configuration controlling context extraction.
            subject_properties: Custom properties to include in the subject.
            resource_properties: Custom properties to include in the resource.
        """
        self.config = config
        self.subject_properties = subject_properties or {}
        self.resource_properties = resource_properties or {}

    def extract_subject(self) -> Subject:
        """Extract subject information from configuration.

        Since Claude Agent SDK's can_use_tool callback doesn't provide user context
        directly, subject information is captured at callback creation time via
        the factory pattern.

        Returns:
            Subject with type, id, and properties for the subject.
        """
        # Start with custom subject properties (e.g., role, scope)
        properties: dict[str, Any] = dict(self.subject_properties)

        # Add user_id and session_id if provided
        if self.config.user_id:
            properties["user_id"] = self.config.user_id

        if self.config.session_id:
            properties["session_id"] = self.config.session_id

        # Build subject id
        subject_id = self.config.user_id or "claude-agent"

        return Subject(
            type="user",
            id=subject_id,
            properties=properties if properties else {},
        )

    def extract_resource(self, tool_name: str, tool_input: dict[str, Any]) -> Resource:
        """Extract resource information from tool and arguments.

        Args:
            tool_name: Name of the tool being invoked.
            tool_input: Arguments passed to the tool.

        Returns:
            Resource with type, id, and properties for the resource.
        """
        # Start with custom resource properties (e.g., scope)
        properties: dict[str, Any] = dict(self.resource_properties)

        # Add tool name
        properties["tool_name"] = tool_name

        # Add tool input if configured (aligned with ADK structure)
        if self.config.extract_tool_args and tool_input:
            properties["tool_input"] = {"values": tool_input}

        return Resource(
            type="tool",
            id=tool_name,
            properties=properties,
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
        subject = self.extract_subject()
        resource = self.extract_resource(tool_name, tool_input)
        # Pass tool_input for Bash command analysis
        action_name = extract_action(tool_name, tool_input)
        action = Action(name=action_name)

        return CheckRequest(
            subject=subject,
            action=action,
            resource=resource,
        )
