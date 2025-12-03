import inspect
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

        # TODO this could be based on openapi/swagger specs uploaded by user which we can use generate rules
        # Action verb mapping for tool name patterns
        # Based on analysis of 277 real MCP tools from various services (GitHub, Jira, Slack, Notion, Confluence, Dropbox, etc.)
        self._action_patterns = [
            # Read operations - match at start or after underscore/service prefix
            (
                re.compile(r"(^|_)(read|get|fetch|load|list|search|query|retrieve)_"),
                "read",
            ),
            # Create/Write operations
            (
                re.compile(r"(^|_)(write|create|add|insert|post|save|send|upload)_"),
                "create",
            ),
            # Update operations
            (
                re.compile(r"(^|_)(update|modify|edit|change|set|patch|rename|mark)_"),
                "update",
            ),
            # Delete operations
            (re.compile(r"(^|_)(delete|remove|drop|unshare)_"), "delete"),
            # Special operations - map to most appropriate action
            (
                re.compile(r"(^|_)(share|add_.*_member)_"),
                "update",
            ),
            # Sharing/permissions
            (
                re.compile(r"(^|_)(merge|fork|copy|move)_"),
                "update",
            ),
            # Resource manipulation
            (re.compile(r"(^|_)(lock|unlock|restore)_"), "update"),  # State changes
            # Execute operations (fallback for actions)
            (re.compile(r"(^|_)(execute|run|call|invoke|batch)_"), "execute"),
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

        # Add tool input schema if available
        input_schema = None

        # Try to get schema from MCP tool first
        if hasattr(tool, "raw_mcp_tool") and tool.raw_mcp_tool:
            try:
                mcp_tool = tool.raw_mcp_tool
                if hasattr(mcp_tool, "inputSchema") and mcp_tool.inputSchema:
                    # MCP tools use JSON Schema format
                    input_schema = mcp_tool.inputSchema
            except (ValueError, TypeError, AttributeError):
                pass

        # Fall back to extracting from function signature for FunctionTool
        if input_schema is None and hasattr(tool, "func") and callable(tool.func):
            try:
                sig = inspect.signature(tool.func)
                extracted_schema = {}
                for param_name, param in sig.parameters.items():
                    # Skip if annotation is empty (Mock signature)
                    if param.annotation == inspect.Parameter.empty:
                        continue
                    param_info = {
                        "type": (
                            param.annotation.__name__
                            if hasattr(param.annotation, "__name__")
                            else str(param.annotation)
                        ),
                        "required": param.default == inspect.Parameter.empty,
                    }
                    # Only include default value for simple types
                    if param.default != inspect.Parameter.empty and isinstance(
                        param.default, str | int | float | bool | type(None)
                    ):
                        param_info["default"] = param.default
                    extracted_schema[param_name] = param_info

                if extracted_schema:
                    input_schema = extracted_schema
            except (ValueError, TypeError):
                pass

        if input_schema:
            attributes["tool_input_schema"] = input_schema

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
            if pattern.search(tool_name_lower):
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
