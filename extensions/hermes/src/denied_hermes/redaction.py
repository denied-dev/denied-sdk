from __future__ import annotations

import json
import re
from typing import Any


def _normalized(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def is_sensitive_key(key: str, redact_keys: list[str]) -> bool:
    normalized = _normalized(str(key))
    return any(
        candidate and candidate in normalized
        for candidate in map(_normalized, redact_keys)
    )


def redact_string_secrets(value: str) -> str:
    value = re.sub(
        r"(\bauthorization:\s*(?:bearer|basic)?\s+)([^\s\"';&|]+)",
        r"\1[REDACTED]",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(
        r"(\b(?:api[_-]?key|apikey|token|secret|password|authorization)\b\s*=\s*)([^\s\"';&|]+)",
        r"\1[REDACTED]",
        value,
        flags=re.IGNORECASE,
    )
    return re.sub(
        r"(--(?:api[-_]?key|token|secret|password|authorization)(?:=|\s+))([^\s\"';&|]+)",
        r"\1[REDACTED]",
        value,
        flags=re.IGNORECASE,
    )


def redact_value(
    value: Any, redact_keys: list[str], seen: set[int] | None = None
) -> Any:
    seen = seen or set()
    if isinstance(value, list):
        return [redact_value(item, redact_keys, seen) for item in value]
    if isinstance(value, dict):
        value_id = id(value)
        if value_id in seen:
            return "[Circular]"
        seen.add(value_id)
        return {
            key: "[REDACTED]"
            if is_sensitive_key(str(key), redact_keys)
            else redact_value(nested, redact_keys, seen)
            for key, nested in value.items()
        }
    if isinstance(value, str):
        return redact_string_secrets(value)
    return value


def truncate_json_value(value: Any, max_bytes: int) -> Any:
    raw = json.dumps(value, separators=(",", ":"), default=str)
    original_bytes = len(raw.encode("utf-8"))
    if original_bytes <= max_bytes:
        return value
    return {
        "truncated": True,
        "max_bytes": max_bytes,
        "original_bytes": original_bytes,
        "preview": raw[:max_bytes],
    }
