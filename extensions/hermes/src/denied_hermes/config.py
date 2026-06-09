from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from importlib import import_module
from pathlib import Path
from typing import Any, Literal

logger = logging.getLogger(__name__)

DEFAULT_DENIED_URL = "https://api.denied.dev"
DEFAULT_TIMEOUT_SECONDS = 15.0
DEFAULT_FAIL_MODE: Literal["open", "closed"] = "open"
DEFAULT_CONTEXT_MAX_BYTES = 20_000
DEFAULT_REDACT_KEYS = [
    "api_key",
    "apikey",
    "authorization",
    "password",
    "secret",
    "token",
]
VALID_FAIL_MODES = {"open", "closed"}
VALID_SUBJECT_IDS = {"session", "task", "tool_call"}


@dataclass(frozen=True)
class AuditConfig:
    enabled: bool = False
    dir: Path = field(default_factory=lambda: hermes_home() / "denied-audit")
    include_raw_payload: bool = True
    include_mapped_request: bool = True
    include_decision: bool = True


@dataclass(frozen=True)
class PluginConfig:
    url: str = DEFAULT_DENIED_URL
    api_key: str = ""
    fail_mode: Literal["open", "closed"] = DEFAULT_FAIL_MODE
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    include_tool_input: bool = True
    use_semantic_mapping: bool = True
    subject_id: Literal["session", "task", "tool_call"] = "session"
    include_hook_payload: bool = True
    redaction_enabled: bool = True
    max_context_bytes: int = DEFAULT_CONTEXT_MAX_BYTES
    redact_keys: list[str] = field(default_factory=lambda: DEFAULT_REDACT_KEYS.copy())
    audit: AuditConfig = field(default_factory=AuditConfig)


class ConfigError(Exception):
    """Raised when explicit Denied plugin configuration cannot be loaded."""


def _expand_home(value: str | Path) -> Path:
    return Path(value).expanduser()


def hermes_home() -> Path:
    explicit = os.getenv("HERMES_HOME")
    if explicit:
        return _expand_home(explicit)

    try:
        hermes_constants = import_module("hermes_constants")
    except ImportError:
        return _expand_home("~/.hermes")

    helper_name = "get_hermes_home"
    get_hermes_home = getattr(hermes_constants, helper_name)
    return Path(get_hermes_home())


def _as_mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _interpolate_env(value: Any) -> Any:
    if isinstance(value, str):
        result = value
        for key, env_value in os.environ.items():
            result = result.replace(f"${{{key}}}", env_value)
        return result
    if isinstance(value, list):
        return [_interpolate_env(item) for item in value]
    if isinstance(value, dict):
        return {key: _interpolate_env(nested) for key, nested in value.items()}
    return value


def _candidate_config_paths() -> list[Path]:
    explicit = os.getenv("DENIED_CONFIG") or os.getenv("DENIED_HERMES_CONFIG")
    if explicit:
        return [_expand_home(explicit)]
    return [
        hermes_home() / "denied.json",
        Path("/opt/data/denied.json"),
    ]


def read_config_file() -> dict[str, Any]:
    explicit = os.getenv("DENIED_CONFIG") or os.getenv("DENIED_HERMES_CONFIG")
    candidates = _candidate_config_paths()
    config_path = next((path for path in candidates if path.exists()), None)

    if explicit and config_path is None:
        msg = f"Denied config was explicitly set but not found at {_expand_home(explicit)}"
        raise ConfigError(msg)
    if config_path is None:
        return {}

    try:
        return _interpolate_env(json.loads(config_path.read_text(encoding="utf-8")))
    except Exception as exc:
        msg = f"Failed to read Denied config at {config_path}: {exc}"
        if explicit:
            raise ConfigError(msg) from exc
        logger.warning("%s; continuing with env/default config.", msg)
        return {}


def _positive_int(value: Any, fallback: int, name: str) -> int:
    if value in (None, ""):
        return fallback
    try:
        parsed = int(str(value))
    except ValueError:
        logger.warning("Invalid %s: %s. Using default %s.", name, value, fallback)
        return fallback
    if parsed > 0:
        return parsed
    logger.warning("Invalid %s: %s. Using default %s.", name, value, fallback)
    return fallback


def _positive_seconds_from_ms(value: Any, fallback_seconds: float, name: str) -> float:
    parsed_ms = _positive_int(value, int(fallback_seconds * 1000), name)
    return parsed_ms / 1000


def _fail_mode(value: Any) -> Literal["open", "closed"]:
    mode = str(value or DEFAULT_FAIL_MODE).lower()
    if mode in VALID_FAIL_MODES:
        return mode  # type: ignore[return-value]
    logger.warning("Invalid failMode: %s. Using default %s.", value, DEFAULT_FAIL_MODE)
    return DEFAULT_FAIL_MODE


def _subject_id(value: Any) -> Literal["session", "task", "tool_call"]:
    subject_id = str(value or "session")
    if subject_id in VALID_SUBJECT_IDS:
        return subject_id  # type: ignore[return-value]
    logger.warning("Invalid subjectId: %s. Using default session.", value)
    return "session"


def resolve_config() -> PluginConfig:
    file_config = read_config_file()
    request_config = _as_mapping(file_config.get("request"))
    redaction_config = _as_mapping(file_config.get("redaction"))
    audit_config = _as_mapping(file_config.get("audit"))
    redaction_keys = [str(item) for item in _as_list(redaction_config.get("keys"))]

    audit_dir = _expand_home(audit_config.get("dir") or hermes_home() / "denied-audit")

    return PluginConfig(
        url=os.getenv("DENIED_URL") or file_config.get("url") or DEFAULT_DENIED_URL,
        api_key=os.getenv("DENIED_API_KEY") or file_config.get("apiKey") or "",
        fail_mode=_fail_mode(
            os.getenv("DENIED_FAIL_MODE")
            or file_config.get("failMode")
            or DEFAULT_FAIL_MODE
        ),
        timeout_seconds=_positive_seconds_from_ms(
            os.getenv("DENIED_TIMEOUT_MS") or file_config.get("timeoutMs"),
            DEFAULT_TIMEOUT_SECONDS,
            "timeoutMs",
        ),
        include_tool_input=request_config.get("includeToolInput", True),
        use_semantic_mapping=file_config.get("useSemanticMapping", True),
        subject_id=_subject_id(file_config.get("subjectId") or "session"),
        include_hook_payload=request_config.get("includeHookPayload", True),
        redaction_enabled=redaction_config.get("enabled", True),
        max_context_bytes=_positive_int(
            request_config.get("maxContextBytes"),
            DEFAULT_CONTEXT_MAX_BYTES,
            "request.maxContextBytes",
        ),
        redact_keys=redaction_keys or DEFAULT_REDACT_KEYS.copy(),
        audit=AuditConfig(
            enabled=audit_config.get("enabled") is True,
            dir=audit_dir,
            include_raw_payload=audit_config.get("includeRawPayload", True),
            include_mapped_request=audit_config.get("includeMappedRequest", True),
            include_decision=audit_config.get("includeDecision", True),
        ),
    )
