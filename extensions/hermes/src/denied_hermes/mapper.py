from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from denied_sdk.schemas.check import CheckRequest

from .config import PluginConfig
from .redaction import redact_value, truncate_json_value


def _as_mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def basename_for_command(command: str) -> str:
    trimmed = command.strip()
    if not trimmed:
        return "unknown"
    return Path(trimmed.split()[0]).name


def infer_shell_effect(command: str) -> str:
    patterns = [
        (re.compile(r"\b(rm|rmdir|unlink)\b", re.IGNORECASE), "delete"),
        (re.compile(r"\bsed\s+-i\b", re.IGNORECASE), "update"),
        (re.compile(r"\bchmod\b|\bchown\b|\bchgrp\b", re.IGNORECASE), "update"),
        (re.compile(r"[^|]>\s*\S|[^|]>>\s*\S"), "create"),
        (
            re.compile(
                r"\b(cp|mv|mkdir|touch|rsync|scp|wget\s+-O|curl\s+-o)\b",
                re.IGNORECASE,
            ),
            "create",
        ),
        (re.compile(r"\b(tee|dd)\b", re.IGNORECASE), "create"),
        (
            re.compile(
                r"\b(cat|head|tail|less|more|grep|find|ls|pwd|whoami|echo(?!\s.*>)|file|stat|wc|diff|which|type|env|printenv|date|uname)\b",
                re.IGNORECASE,
            ),
            "read",
        ),
    ]
    for pattern, effect in patterns:
        if pattern.search(command):
            return effect
    return "execute"


def infer_effect(tool_name: str, tool_input: dict[str, Any]) -> str:
    lower_tool = tool_name.lower()
    command = tool_input.get("command")
    if lower_tool in {"terminal", "bash"} and isinstance(command, str):
        return infer_shell_effect(command)

    patterns = [
        (
            re.compile(
                r"^(read|glob|grep|webfetch|websearch|web_search|listmcpresourcestool|readmcpresourcetool)$",
                re.IGNORECASE,
            ),
            "read",
        ),
        (re.compile(r"^(write|notebookedit)$", re.IGNORECASE), "create"),
        (re.compile(r"^(edit|multiedit|patch)$", re.IGNORECASE), "update"),
        (
            re.compile(r"(^|_)(execute|run|call|invoke|batch)(_|$)", re.IGNORECASE),
            "execute",
        ),
        (re.compile(r"(^|_)(share|add_.*_member)(_|$)", re.IGNORECASE), "update"),
        (re.compile(r"(^|_)(merge|fork|copy|move)(_|$)", re.IGNORECASE), "update"),
        (re.compile(r"(^|_)(lock|unlock|restore)(_|$)", re.IGNORECASE), "update"),
        (
            re.compile(r"(^|_)(delete|remove|drop|unshare)(_|$)", re.IGNORECASE),
            "delete",
        ),
        (
            re.compile(
                r"(^|_)(update|modify|edit|change|set|patch|rename|mark)(_|$)",
                re.IGNORECASE,
            ),
            "update",
        ),
        (
            re.compile(
                r"(^|_)(write|create|add|insert|post|save|send|upload)(_|$)",
                re.IGNORECASE,
            ),
            "create",
        ),
        (
            re.compile(
                r"(^|_)(read|get|fetch|load|list|search|query|retrieve)(_|$)",
                re.IGNORECASE,
            ),
            "read",
        ),
    ]
    for pattern, effect in patterns:
        if pattern.search(tool_name):
            return effect
    return "execute"


def normalize_operation_name(value: Any) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_.:-]+", "_", str(value or "unknown").strip())
    return normalized.strip("_").lower() or "unknown"


def _first_string(*values: Any) -> str | None:
    return next((value for value in values if isinstance(value, str) and value), None)


def infer_operation(tool_name: str, tool_input: dict[str, Any]) -> str:
    lower_tool = tool_name.lower()
    if lower_tool in {"terminal", "bash"}:
        return "run_command"
    if lower_tool == "websearch":
        return "web_search"
    if lower_tool == "webfetch":
        return "web_fetch"
    method = _first_string(tool_input.get("method"))
    if method and _first_string(
        tool_input.get("url"), tool_input.get("uri"), tool_input.get("endpoint")
    ):
        return f"http_{method.lower()}"
    return normalize_operation_name(tool_name)


def resolve_path(input_path: str, cwd: str | None) -> str:
    expanded = Path(input_path).expanduser()
    if expanded.is_absolute():
        return str(expanded)
    return str(Path(cwd or Path.cwd(), expanded).resolve())


def infer_resource(
    tool_name: str,
    tool_input: dict[str, Any],
    cwd: str | None,
    effect: str,
    use_semantic_mapping: bool,
) -> dict[str, Any]:
    if not use_semantic_mapping:
        return {"type": "tool", "id": tool_name, "capability": "tool.call"}

    lower_tool = tool_name.lower()
    if lower_tool in {"terminal", "bash"}:
        command_value = tool_input.get("command")
        command = command_value if isinstance(command_value, str) else ""
        return {
            "type": "command",
            "id": basename_for_command(command),
            "capability": "shell.command",
            "properties": {"command": command},
        }

    path_value = _first_string(
        tool_input.get("path"),
        tool_input.get("file_path"),
        tool_input.get("filePath"),
        tool_input.get("filename"),
    )
    if path_value:
        return {
            "type": "file",
            "id": resolve_path(path_value, cwd),
            "capability": "filesystem.read"
            if effect == "read"
            else "filesystem.delete"
            if effect == "delete"
            else "filesystem.write",
            "properties": {"path": path_value},
        }

    url_value = _first_string(
        tool_input.get("url"), tool_input.get("uri"), tool_input.get("endpoint")
    )
    if url_value:
        return {
            "type": "url",
            "id": url_value,
            "capability": "network.request",
            "properties": {
                "url": url_value,
                "method": _first_string(tool_input.get("method")),
            },
        }

    if "web_search" in lower_tool or "websearch" in lower_tool:
        return {
            "type": "web-search",
            "id": "default",
            "capability": "network.search",
            "properties": {"query": _first_string(tool_input.get("query"))},
        }

    return {"type": "tool", "id": tool_name, "capability": "tool.call"}


def subject_id_from_payload(payload: dict[str, Any], mode: str) -> str:
    extra = _as_mapping(payload.get("extra"))
    if mode == "task":
        return extra.get("task_id") or payload.get("session_id") or "unknown"
    if mode == "tool_call":
        return extra.get("tool_call_id") or payload.get("session_id") or "unknown"
    return payload.get("session_id") or extra.get("task_id") or "unknown"


class ContextMapper:
    def __init__(self, config: PluginConfig):
        self.config = config

    def _redact_if_enabled(self, value: Any) -> Any:
        if not self.config.redaction_enabled:
            return value
        return redact_value(value, self.config.redact_keys)

    def _bounded_if_enabled(self, value: Any) -> Any:
        return truncate_json_value(
            self._redact_if_enabled(value), self.config.max_context_bytes
        )

    def create_check_request(self, payload: dict[str, Any]) -> CheckRequest:
        from denied_sdk.schemas.check import Action, CheckRequest, Resource, Subject

        tool_name = payload.get("tool_name") or "unknown"
        tool_input = _as_mapping(payload.get("tool_input"))
        extra = _as_mapping(payload.get("extra"))
        cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else None
        effect = infer_effect(tool_name, tool_input)
        operation = infer_operation(tool_name, tool_input)
        resource_info = infer_resource(
            tool_name,
            tool_input,
            cwd,
            effect,
            self.config.use_semantic_mapping,
        )

        resource_properties = {
            **_as_mapping(resource_info.get("properties")),
            "tool_name": tool_name,
            "tool_call_id": extra.get("tool_call_id"),
            "raw_tool": {
                "name": tool_name,
                **(
                    {"input": self._bounded_if_enabled(tool_input)}
                    if self.config.include_tool_input
                    else {}
                ),
            },
        }
        if "command" in resource_properties:
            resource_properties["command"] = self._bounded_if_enabled(
                resource_properties["command"]
            )

        context: dict[str, Any] = {
            "integration": "denied-hermes-shell-hook",
            "hook_event_name": payload.get("hook_event_name"),
            "authz_direction": "agent-to-world",
        }
        if self.config.include_hook_payload:
            context["hook_payload"] = self._bounded_if_enabled(payload)

        return CheckRequest(
            subject=Subject(
                type="hermes-agent",
                id=subject_id_from_payload(payload, self.config.subject_id),
                properties={
                    "runtime": "hermes-agent",
                    "session_id": payload.get("session_id"),
                    "task_id": extra.get("task_id"),
                    "cwd": cwd,
                },
            ),
            action=Action(
                name=operation,
                properties={
                    "effect": effect,
                    "tool_name": tool_name,
                    "capability": resource_info["capability"],
                },
            ),
            resource=Resource(
                type=resource_info["type"],
                id=resource_info["id"],
                properties=resource_properties,
            ),
            context=context,
        )


def payload_from_hook(
    tool_name: str | None,
    args: dict[str, Any] | None,
    task_id: str | None,
    **kwargs: Any,
) -> dict[str, Any]:
    extra = dict(kwargs)
    if task_id and "task_id" not in extra:
        extra["task_id"] = task_id
    session_id = (
        extra.get("session_id")
        or extra.get("session")
        or extra.get("conversation_id")
        or task_id
        or "unknown"
    )
    cwd = extra.get("cwd") if isinstance(extra.get("cwd"), str) else str(Path.cwd())
    return {
        "hook_event_name": "pre_tool_call",
        "tool_name": tool_name or "unknown",
        "tool_input": args or {},
        "session_id": session_id,
        "cwd": cwd,
        "extra": extra,
    }
