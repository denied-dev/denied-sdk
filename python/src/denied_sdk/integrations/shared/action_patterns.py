"""Shared action pattern extraction for tool authorization.

This module provides common action pattern matching used across
different SDK integrations (Claude Agent SDK, Google ADK, etc.).
"""

import re

# Action verb mapping for tool name patterns
# Combines Claude Code built-in tools with MCP tool naming conventions
_ACTION_PATTERNS = [
    # === Claude Code Built-in Tools (exact matches) ===
    # Read operations
    (
        re.compile(
            r"^(Read|Glob|Grep|WebFetch|WebSearch|ListMcpResourcesTool|ReadMcpResourceTool)$",
            re.IGNORECASE,
        ),
        "read",
    ),
    # Create/Write operations
    (
        re.compile(r"^Write$", re.IGNORECASE),
        "create",
    ),
    # Update operations
    (
        re.compile(r"^(Edit|MultiEdit|NotebookEdit)$", re.IGNORECASE),
        "update",
    ),
    # Execute operations
    (
        re.compile(r"^(Bash|Task|TodoWrite|KillShell)$", re.IGNORECASE),
        "execute",
    ),
    # === MCP Tool Naming Patterns ===
    # Read operations
    (
        re.compile(
            r"(^|_)(read|get|fetch|load|list|search|query|retrieve)(_|$)",
            re.IGNORECASE,
        ),
        "read",
    ),
    # Create/Write operations
    (
        re.compile(
            r"(^|_)(write|create|add|insert|post|save|send|upload)(_|$)",
            re.IGNORECASE,
        ),
        "create",
    ),
    # Update operations
    (
        re.compile(
            r"(^|_)(update|modify|edit|change|set|patch|rename|mark)(_|$)",
            re.IGNORECASE,
        ),
        "update",
    ),
    # Delete operations
    (
        re.compile(r"(^|_)(delete|remove|drop|unshare)(_|$)", re.IGNORECASE),
        "delete",
    ),
    # Special operations - map to most appropriate action
    (
        re.compile(r"(^|_)(share|add_.*_member)(_|$)", re.IGNORECASE),
        "update",
    ),
    # Resource manipulation
    (
        re.compile(r"(^|_)(merge|fork|copy|move)(_|$)", re.IGNORECASE),
        "update",
    ),
    # State changes
    (
        re.compile(r"(^|_)(lock|unlock|restore)(_|$)", re.IGNORECASE),
        "update",
    ),
    # Execute operations
    (
        re.compile(r"(^|_)(execute|run|call|invoke|batch)(_|$)", re.IGNORECASE),
        "execute",
    ),
]


def extract_action(tool_name: str) -> str:
    """Extract action from tool name.

    Attempts to infer the action from the tool name by matching
    common verb patterns (read, create, update, delete, execute).
    Falls back to "execute" if no pattern matches.

    Supports both:
    - Claude Code built-in tools (Read, Write, Edit, Bash, etc.)
    - MCP tool naming conventions (read_file, create_user, etc.)

    Args:
        tool_name: Name of the tool being invoked.

    Returns:
        Action string: "read", "create", "update", "delete", or "execute".

    Examples:
        >>> extract_action("Read")
        'read'
        >>> extract_action("Write")
        'create'
        >>> extract_action("get_user")
        'read'
        >>> extract_action("delete_file")
        'delete'
        >>> extract_action("unknown_tool")
        'execute'
    """
    for pattern, action in _ACTION_PATTERNS:
        if pattern.search(tool_name):
            return action

    # Default action
    return "execute"
