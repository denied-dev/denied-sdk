from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from denied_sdk.schemas.check import CheckRequest, CheckResponse

from .config import ConfigError, PluginConfig, resolve_config
from .mapper import ContextMapper, payload_from_hook
from .redaction import redact_value, truncate_json_value

logger = logging.getLogger(__name__)


class DeniedCheckClient(Protocol):
    def check(
        self,
        *,
        subject: Any,
        action: Any,
        resource: Any,
        context: dict[str, Any] | None,
    ) -> CheckResponse: ...

    def close(self) -> None: ...


def _reason_from_response(response: CheckResponse) -> str:
    if response.context and response.context.reason:
        return response.context.reason
    if response.decision:
        return "Authorization allowed by Denied policy engine."
    return "Authorization denied by Denied policy engine."


class DeniedHermesPlugin:
    def __init__(
        self,
        config: PluginConfig | None = None,
        denied_client: DeniedCheckClient | None = None,
    ) -> None:
        self.config = config or resolve_config()
        if denied_client is None:
            try:
                from denied_sdk import DeniedClient
            except ImportError as exc:
                raise RuntimeError(
                    "denied-sdk is required for the Denied Hermes plugin. "
                    "Install it in the Hermes Python environment, or install this "
                    "plugin package with its dependencies."
                ) from exc
            self.client = DeniedClient(
                url=self.config.url,
                api_key=self.config.api_key,
                timeout=self.config.timeout_seconds,
            )
        else:
            self.client = denied_client
        self.mapper = ContextMapper(self.config)

    def pre_tool_call(
        self,
        tool_name: str | None = None,
        args: dict[str, Any] | None = None,
        task_id: str | None = None,
        **kwargs: Any,
    ) -> dict[str, str] | None:
        if not self.config.api_key:
            return self._fail_safe(
                "DENIED_API_KEY/apiKey is not set. Skipping authorization check."
            )

        payload = payload_from_hook(tool_name, args, task_id, **kwargs)
        request = self.mapper.create_check_request(payload)

        try:
            result = self.client.check(
                subject=request.subject,
                action=request.action,
                resource=request.resource,
                context=request.context,
            )
        except Exception as exc:
            message = f"Failed to reach Denied PDP: {exc}"
            self._append_audit_record(payload, request, {"error": message})
            return self._fail_safe(message)

        self._append_audit_record(payload, request, result)
        reason = _reason_from_response(result)
        if result.decision:
            return None

        logger.info("Blocked tool call: %s", tool_name or "unknown")
        return self._block(reason)

    def _fail_safe(self, message: str) -> dict[str, str] | None:
        logger.warning(message)
        if self.config.fail_mode == "closed":
            return self._block(
                f"Denied policy engine unavailable and fail-mode is closed. {message}"
            )
        logger.warning(
            "Denied policy engine unavailable and fail-mode is open. %s", message
        )
        return None

    @staticmethod
    def _block(reason: str) -> dict[str, str]:
        return {
            "action": "block",
            "message": reason or "Authorization denied by Denied policy engine.",
        }

    def _redact_if_enabled(self, value: Any) -> Any:
        if not self.config.redaction_enabled:
            return value
        return redact_value(value, self.config.redact_keys)

    def _audit_value(self, value: Any) -> Any:
        return truncate_json_value(
            self._redact_if_enabled(value), self.config.max_context_bytes
        )

    def _append_audit_record(
        self,
        payload: dict[str, Any],
        request: CheckRequest,
        decision: CheckResponse | dict[str, Any],
    ) -> None:
        if not self.config.audit.enabled:
            return

        try:
            self.config.audit.dir.mkdir(parents=True, exist_ok=True)
            record: dict[str, Any] = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            if self.config.audit.include_raw_payload:
                record["hook_payload"] = self._audit_value(payload)
            if self.config.audit.include_mapped_request:
                record["mapped_request"] = self._audit_value(request.model_dump())
            if self.config.audit.include_decision:
                if isinstance(decision, dict):
                    record["decision"] = self._redact_if_enabled(decision)
                else:
                    record["decision"] = self._redact_if_enabled(decision.model_dump())

            audit_file = self.config.audit.dir / "denied-hermes-hook.jsonl"
            with audit_file.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, default=str) + "\n")
        except Exception as exc:
            logger.warning("Failed to write audit record: %s", exc)

    def close(self) -> None:
        self.client.close()


def register(ctx: Any) -> None:
    try:
        plugin = DeniedHermesPlugin()
    except ConfigError as exc:
        message = str(exc)
        logger.warning("Denied Hermes plugin disabled: %s", message)

        def fail_safe_hook(**_kwargs: Any) -> dict[str, str] | None:
            if os.getenv("DENIED_FAIL_MODE", "open").lower() == "closed":
                return {
                    "action": "block",
                    "message": (
                        "Denied policy engine unavailable and fail-mode is closed. "
                        f"{message}"
                    ),
                }
            return None

        ctx.register_hook("pre_tool_call", fail_safe_hook)
        return

    ctx.register_hook("pre_tool_call", plugin.pre_tool_call)
