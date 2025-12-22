"""Shared action pattern extraction for tool authorization.

This module provides common action pattern matching used across
different SDK integrations (Claude Agent SDK, Google ADK, etc.).
"""

import re
from typing import Any

# Type alias for clarity
ActionPattern = tuple[re.Pattern[str], str]


def _p(pattern: str, action: str, flags: int = re.IGNORECASE) -> ActionPattern:
    """Create a compiled pattern tuple."""
    return (re.compile(pattern, flags), action)


# Bash command patterns - order matters (specific first)
_BASH_ACTION_PATTERNS: list[ActionPattern] = [
    # File redirection (not pipe)
    _p(r"[^|]>\s*\S|[^|]>>\s*\S", "create", 0),
    # Write commands
    _p(r"\b(cp|mv|mkdir|touch|rsync|scp|wget\s+-O|curl\s+-o)\b", "create"),
    _p(r"\b(tee|dd)\b", "create"),
    # Delete
    _p(r"\b(rm|rmdir|unlink)\b", "delete"),
    # Update (in-place)
    _p(r"\bsed\s+-i\b", "update"),
    _p(r"\b(chmod|chown|chgrp)\b", "update"),
    # Read (most general, last)
    _p(
        r"\b(cat|head|tail|less|more|grep|find|ls|pwd|whoami|echo(?!\s.*>)|"
        r"file|stat|wc|diff|which|type|env|printenv|date|uname)\b",
        "read",
    ),
]

# Tool name patterns - Claude Code built-ins + MCP conventions
# Order matters: specific patterns before general
_ACTION_PATTERNS: list[ActionPattern] = [
    # Claude Code built-in tools (exact match)
    _p(
        r"^(Read|Glob|Grep|WebFetch|WebSearch|ListMcpResourcesTool|ReadMcpResourceTool)$",
        "read",
    ),
    _p(r"^(Write)$", "create"),
    _p(r"^(Edit|MultiEdit|NotebookEdit)$", "update"),
    _p(r"^(Task|TodoWrite|KillShell)$", "execute"),
    # MCP patterns - specific operations first
    _p(r"(^|_)(execute|run|call|invoke|batch)(_|$)", "execute"),
    _p(r"(^|_)(share|add_.*_member)(_|$)", "update"),
    _p(r"(^|_)(merge|fork|copy|move)(_|$)", "update"),
    _p(r"(^|_)(lock|unlock|restore)(_|$)", "update"),
    _p(r"(^|_)(delete|remove|drop|unshare)(_|$)", "delete"),
    _p(r"(^|_)(update|modify|edit|change|set|patch|rename|mark)(_|$)", "update"),
    _p(r"(^|_)(write|create|add|insert|post|save|send|upload)(_|$)", "create"),
    # Read (most general, must be last)
    _p(r"(^|_)(read|get|fetch|load|list|search|query|retrieve)(_|$)", "read"),
]


def _extract_bash_action(command: str) -> str:
    """Extract action from a Bash command string.

    Analyzes the command content to determine the actual operation type,
    since Bash can perform read, write, delete, or execute operations.

    Args:
        command: The bash command string to analyze.

    Returns:
        Action string based on command analysis.
    """
    for pattern, action in _BASH_ACTION_PATTERNS:
        if pattern.search(command):
            return action
    return "execute"


def extract_action(tool_name: str, tool_input: dict[str, Any] | None = None) -> str:
    """Extract action from tool name and optionally tool input.

    Attempts to infer the action from the tool name by matching
    common verb patterns (read, create, update, delete, execute).
    Falls back to "execute" if no pattern matches.

    For the Bash tool, analyzes the command content to determine
    the actual operation type (read, create, update, delete, execute).

    Supports both:
    - Claude Code built-in tools (Read, Write, Edit, Bash, etc.)
    - MCP tool naming conventions (read_file, create_user, etc.)

    Args:
        tool_name: Name of the tool being invoked.
        tool_input: Optional tool input arguments. Used for Bash command analysis.

    Returns:
        Action string: "read", "create", "update", "delete", or "execute".

    Examples:
        >>> extract_action("Read")
        'read'
        >>> extract_action("Write")
        'create'
        >>> extract_action("Bash", {"command": "ls -la"})
        'read'
        >>> extract_action("Bash", {"command": "echo hello > file.txt"})
        'create'
        >>> extract_action("Bash", {"command": "rm file.txt"})
        'delete'
        >>> extract_action("get_user")
        'read'
        >>> extract_action("delete_file")
        'delete'
        >>> extract_action("unknown_tool")
        'execute'
    """
    # Special handling for Bash tool - analyze command content
    if tool_name.lower() == "bash" and tool_input:
        command = tool_input.get("command", "")
        if command:
            return _extract_bash_action(command)

    for pattern, action in _ACTION_PATTERNS:
        if pattern.search(tool_name):
            return action

    return "execute"
