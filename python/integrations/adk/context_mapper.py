import re
from typing import TYPE_CHECKING, Any

from denied_sdk.enums.entity import EntityType
from denied_sdk.schemas.check import CheckRequest, PrincipalCheck, ResourceCheck

from .config import AuthorizationConfig

if TYPE_CHECKING:
    from google.adk.tools.base_tool import BaseTool
    from google.adk.tools.tool_context import ToolContext


class ContextMapper:
    """Maps ADK tool execution context to Denied authorization model.

    This class extracts relevant context from ADK's ToolContext and tool
    information to construct authorization requests for the Denied service.

    Args:
        config: Authorization configuration controlling what context to extract.

    Example:
        mapper = ContextMapper(config)
        request = mapper.create_check_request(tool, tool_args, tool_context)
    """

    def __init__(self, config: AuthorizationConfig):
        """Initialize the context mapper.

        Args:
            config: Configuration controlling context extraction.
        """
        self.config = config

        # Action verb mapping for common tool name patterns
        # TODO basic mapper for now...
        self._action_patterns = [
            (re.compile(r"^(read|get|fetch|load|list|search|query)_"), "read"),
            (re.compile(r"^(write|create|add|insert|post|save)_"), "write"),
            (re.compile(r"^(update|modify|edit|change|set)_"), "update"),
            (re.compile(r"^(delete|remove|drop)_"), "delete"),
            (re.compile(r"^(execute|run|call|invoke)_"), "execute"),
        ]

    def extract_principal(self, tool_context: "ToolContext") -> PrincipalCheck:
        """Extract principal information from ADK tool context.

        Args:
            tool_context: The ADK tool execution context.

        Returns:
            PrincipalCheck with URI and attributes for the principal.
        """
        attributes: dict[str, Any] = {}

        if self.config.include_user_id:
            attributes["user_id"] = tool_context.user_id

        if self.config.include_agent_name:
            attributes["agent_name"] = tool_context.agent_name

        if self.config.include_session_id:
            attributes["session_id"] = tool_context.session.id

        # Add invocation ID for tracking
        attributes["invocation_id"] = tool_context.invocation_id

        # Extract role and other attributes from session state
        state = tool_context.state.to_dict()
        if "role" in state:
            attributes["role"] = state["role"]
        if "department" in state:
            attributes["department"] = state["department"]

        # Build principal URI
        principal_uri = f"user:{tool_context.user_id}"

        return PrincipalCheck(
            type=EntityType.principal,
            uri=principal_uri,
            attributes=attributes,
        )

    def extract_resource(
        self, tool: "BaseTool", tool_args: dict[str, Any], tool_context: "ToolContext"
    ) -> ResourceCheck:
        """Extract resource information from tool and arguments.

        Args:
            tool: The tool being invoked.
            tool_args: Arguments passed to the tool.

        Returns:
            ResourceCheck with URI and attributes for the resource.
        """
        attributes: dict[str, Any] = {
            "tool_name": tool.name,
        }

        # Add tool description if available
        if hasattr(tool, "description") and tool.description:
            attributes["tool_description"] = tool.description

        # Add tool metadata if available
        if hasattr(tool, "custom_metadata") and tool.custom_metadata:
            attributes.update(tool.custom_metadata)

        # Extract tool arguments if configured
        if self.config.extract_tool_args:
            # Common argument names that represent resources
            resource_arg_names = [
                "file_path",
                "path",
                "filename",
                "resource_id",
                "document_id",
                "object_id",
                "key",
                "name",
            ]

            for arg_name in resource_arg_names:
                if arg_name in tool_args:
                    attributes[arg_name] = tool_args[arg_name]

        # Extract scope from session state if available
        state = tool_context.state.to_dict()
        if "resource_scope" in state:
            attributes["scope"] = state["resource_scope"]

        # Build resource URI
        resource_uri = f"tool:{tool.name}"

        return ResourceCheck(
            type=EntityType.resource,
            uri=resource_uri,
            attributes=attributes,
        )

    def extract_action(self, tool: "BaseTool") -> str:
        """Extract action from tool name.

        Attempts to infer the action from the tool name by matching
        common verb patterns (read, write, update, delete, execute).
        Falls back to "execute" if no pattern matches.

        Args:
            tool: The tool being invoked.

        Returns:
            Action string (e.g., "read", "write", "execute").
        """
        tool_name_lower = tool.name.lower()

        # Try to match action patterns
        for pattern, action in self._action_patterns:
            if pattern.match(tool_name_lower):
                return action

        # Default action
        return "execute"

    def create_check_request(
        self,
        tool: "BaseTool",
        tool_args: dict[str, Any],
        tool_context: "ToolContext",
    ) -> CheckRequest:
        """Create a complete authorization check request.

        Args:
            tool: The tool being invoked.
            tool_args: Arguments passed to the tool.
            tool_context: The ADK tool execution context.

        Returns:
            CheckRequest ready to send to Denied service.
        """
        principal = self.extract_principal(tool_context)
        resource = self.extract_resource(tool, tool_args, tool_context)
        action = self.extract_action(tool)

        return CheckRequest(
            principal=principal,
            resource=resource,
            action=action,
        )
