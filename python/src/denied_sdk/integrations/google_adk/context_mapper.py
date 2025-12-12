import inspect
from typing import TYPE_CHECKING, Any

from denied_sdk.enums.entity import EntityType
from denied_sdk.integrations.shared import extract_action
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

    def extract_principal(self, tool_context: "ToolContext") -> PrincipalCheck:
        """Extract principal information from ADK tool context.

        Args:
            tool_context: The ADK tool execution context.

        Returns:
            PrincipalCheck with URI and attributes for the principal.
        """
        attributes: dict[str, Any] = {}

        # Always include context identifiers
        attributes["user_id"] = tool_context.user_id
        attributes["agent_name"] = tool_context.agent_name
        attributes["session_id"] = tool_context.session.id
        attributes["invocation_id"] = tool_context.invocation_id

        # Extract configured state keys into principal attributes
        if self.config.principal_state_keys:
            state = tool_context.state.to_dict()
            for key in self.config.principal_state_keys:
                if key in state:
                    attributes[key] = state[key]

        # Build principal URI
        principal_uri = f"user:{tool_context.user_id}"

        return PrincipalCheck(
            type=EntityType.principal,
            uri=principal_uri,
            attributes=attributes,
        )

    def _extract_input_schema(self, tool: "BaseTool") -> dict[str, Any] | None:
        """Extract tool input schema from MCP tool or function signature.

        Args:
            tool: The tool to extract schema from.

        Returns:
            Input schema dict or None if unavailable.
        """
        # Try to get schema from MCP tool first
        if hasattr(tool, "raw_mcp_tool") and tool.raw_mcp_tool:
            try:
                mcp_tool = tool.raw_mcp_tool
                if hasattr(mcp_tool, "inputSchema") and mcp_tool.inputSchema:
                    # MCP tools use JSON Schema format
                    return mcp_tool.inputSchema
            except (ValueError, TypeError, AttributeError):
                pass

        # Fall back to extracting from function signature for FunctionTool
        if hasattr(tool, "func") and callable(tool.func):
            try:
                sig = inspect.signature(tool.func)
                extracted_schema: dict[str, Any] = {}
                for param_name, param in sig.parameters.items():
                    # Skip if annotation is empty (Mock signature)
                    if param.annotation == inspect.Parameter.empty:
                        continue
                    param_info: dict[str, Any] = {
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
                    return extracted_schema
            except (ValueError, TypeError):
                pass

        return None

    def extract_resource(
        self, tool: "BaseTool", tool_args: dict[str, Any], tool_context: "ToolContext"
    ) -> ResourceCheck:
        """Extract resource information from tool and arguments.

        Args:
            tool: The tool being invoked.
            tool_args: Arguments passed to the tool.
            tool_context: The ADK tool execution context.

        Returns:
            ResourceCheck with URI and attributes for the resource.
        """
        attributes: dict[str, Any] = {
            "tool_name": tool.name,
        }

        # Add tool description if available
        if hasattr(tool, "description") and tool.description:
            attributes["tool_description"] = tool.description

        # Add tool input (schema and values) if configured
        if self.config.extract_tool_args:
            tool_input: dict[str, Any] = {}

            schema = self._extract_input_schema(tool)
            if schema:
                tool_input["schema"] = schema

            if tool_args:
                tool_input["values"] = tool_args

            if tool_input:
                attributes["tool_input"] = tool_input

        # Add tool metadata if available
        if hasattr(tool, "custom_metadata") and tool.custom_metadata:
            attributes.update(tool.custom_metadata)

        # Extract configured state keys into resource attributes
        if self.config.resource_state_keys:
            state = tool_context.state.to_dict()
            for key in self.config.resource_state_keys:
                if key in state:
                    attributes[key] = state[key]

        # Build resource URI
        resource_uri = f"tool:{tool.name}"

        return ResourceCheck(
            type=EntityType.resource,
            uri=resource_uri,
            attributes=attributes,
        )

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
        action = extract_action(tool.name)

        return CheckRequest(
            principal=principal,
            resource=resource,
            action=action,
        )
