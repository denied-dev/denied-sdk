from __future__ import annotations

import importlib.util
import json
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from denied_sdk import CheckResponse, CheckResponseContext

from denied_hermes.config import AuditConfig, ConfigError, PluginConfig, resolve_config
from denied_hermes.mapper import ContextMapper, infer_shell_effect, payload_from_hook
from denied_hermes.plugin import DeniedHermesPlugin, register
from denied_hermes.redaction import redact_value, truncate_json_value


@pytest.fixture(autouse=True)
def isolated_hermes_env(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    for name in (
        "DENIED_CONFIG",
        "DENIED_HERMES_CONFIG",
        "DENIED_URL",
        "DENIED_API_KEY",
        "DENIED_FAIL_MODE",
        "DENIED_TIMEOUT_MS",
    ):
        monkeypatch.delenv(name, raising=False)


class FakeClient:
    def __init__(self, response: CheckResponse | Exception):
        self.response = response
        self.calls: list[dict[str, Any]] = []
        self.closed = False

    def check(self, **kwargs: Any) -> CheckResponse:
        self.calls.append(kwargs)
        if isinstance(self.response, Exception):
            raise self.response
        return self.response

    def close(self) -> None:
        self.closed = True


def config(**overrides: Any) -> PluginConfig:
    return replace(
        PluginConfig(api_key="test-api-key", url="https://pdp.test"), **overrides
    )


def test_register_adds_pre_tool_call_hook(monkeypatch):
    class Context:
        def __init__(self):
            self.hooks = []

        def register_hook(self, name, callback):
            self.hooks.append((name, callback))

    monkeypatch.setenv("DENIED_API_KEY", "test-api-key")
    ctx = Context()

    register(ctx)

    assert len(ctx.hooks) == 1
    assert ctx.hooks[0][0] == "pre_tool_call"
    assert callable(ctx.hooks[0][1])


def test_local_plugin_entrypoint_exports_register():
    plugin_path = Path(__file__).parents[1] / "__init__.py"
    spec = importlib.util.spec_from_file_location("hermes_local_plugin", plugin_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)

    spec.loader.exec_module(module)

    assert module.register is register


def test_resolve_config_uses_env_and_json_config(monkeypatch, tmp_path: Path):
    config_path = tmp_path / "denied.json"
    config_path.write_text(
        json.dumps(
            {
                "url": "https://file-pdp.test",
                "apiKey": "${DENIED_API_KEY}",
                "failMode": "closed",
                "timeoutMs": 2500,
                "request": {
                    "includeHookPayload": False,
                    "includeToolInput": False,
                    "maxContextBytes": 123,
                },
                "redaction": {
                    "enabled": False,
                    "keys": ["private"],
                },
                "audit": {
                    "enabled": True,
                    "dir": str(tmp_path / "audit"),
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("DENIED_CONFIG", str(config_path))
    monkeypatch.setenv("DENIED_API_KEY", "env-key")
    monkeypatch.setenv("DENIED_URL", "https://env-pdp.test")

    resolved = resolve_config()

    assert resolved.url == "https://env-pdp.test"
    assert resolved.api_key == "env-key"
    assert resolved.fail_mode == "closed"
    assert resolved.timeout_seconds == 2.5
    assert resolved.include_hook_payload is False
    assert resolved.include_tool_input is False
    assert resolved.max_context_bytes == 123
    assert resolved.redaction_enabled is False
    assert resolved.redact_keys == ["private"]
    assert resolved.audit.enabled is True
    assert resolved.audit.dir == tmp_path / "audit"


def test_resolve_config_reads_denied_json_from_hermes_home(monkeypatch, tmp_path: Path):
    hermes_home = tmp_path / "profile-home"
    hermes_home.mkdir()
    (hermes_home / "denied.json").write_text(
        json.dumps(
            {
                "url": "https://profile-pdp.test",
                "apiKey": "profile-api-key",
                "failMode": "closed",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))

    resolved = resolve_config()

    assert resolved.url == "https://profile-pdp.test"
    assert resolved.api_key == "profile-api-key"
    assert resolved.fail_mode == "closed"


def test_default_audit_dir_uses_hermes_home(monkeypatch, tmp_path: Path):
    hermes_home = tmp_path / "profile-home"
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))

    resolved = resolve_config()

    assert resolved.audit.dir == hermes_home / "denied-audit"
    assert AuditConfig().dir == hermes_home / "denied-audit"


def test_explicit_missing_config_path_raises(monkeypatch, tmp_path: Path):
    missing_path = tmp_path / "missing-denied.json"
    monkeypatch.setenv("DENIED_CONFIG", str(missing_path))

    with pytest.raises(ConfigError, match="explicitly set but not found"):
        resolve_config()


def test_register_malformed_config_blocks_when_fail_closed(monkeypatch, tmp_path: Path):
    config_path = tmp_path / "denied.json"
    config_path.write_text("{ invalid json", encoding="utf-8")
    monkeypatch.setenv("DENIED_CONFIG", str(config_path))
    monkeypatch.setenv("DENIED_FAIL_MODE", "closed")

    class Context:
        def __init__(self):
            self.callback: Callable[[], dict[str, str] | None] | None = None

        def register_hook(
            self, _name: str, callback: Callable[[], dict[str, str] | None]
        ) -> None:
            self.callback = callback

    ctx = Context()
    register(ctx)

    assert ctx.callback is not None
    result = ctx.callback()

    assert result is not None
    assert result["action"] == "block"
    assert "fail-mode is closed" in result["message"]
    assert "Failed to read Denied config" in result["message"]


def test_register_malformed_config_allows_when_fail_open(monkeypatch, tmp_path: Path):
    config_path = tmp_path / "denied.json"
    config_path.write_text("{ invalid json", encoding="utf-8")
    monkeypatch.setenv("DENIED_CONFIG", str(config_path))
    monkeypatch.setenv("DENIED_API_KEY", "env-api-key")
    monkeypatch.setenv("DENIED_URL", "https://env-pdp.test")
    monkeypatch.setenv("DENIED_FAIL_MODE", "open")

    class Context:
        def __init__(self):
            self.callback: Callable[[], dict[str, str] | None] | None = None

        def register_hook(
            self, _name: str, callback: Callable[[], dict[str, str] | None]
        ) -> None:
            self.callback = callback

    ctx = Context()
    register(ctx)

    assert ctx.callback is not None
    assert ctx.callback() is None


def test_invalid_config_values_fall_back_to_defaults(
    monkeypatch, tmp_path: Path, caplog
):
    config_path = tmp_path / "denied.json"
    config_path.write_text(
        json.dumps(
            {
                "url": "https://pdp.test",
                "apiKey": "test-api-key",
                "failMode": "strict",
                "timeoutMs": "abc",
                "subjectId": "agent",
                "request": {
                    "maxContextBytes": 0,
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("DENIED_CONFIG", str(config_path))
    monkeypatch.setenv("DENIED_FAIL_MODE", "strict-env")

    resolved = resolve_config()

    assert resolved.fail_mode == "open"
    assert resolved.timeout_seconds == 15.0
    assert resolved.subject_id == "session"
    assert resolved.max_context_bytes == 20_000
    assert "Invalid failMode" in caplog.text
    assert "Invalid timeoutMs" in caplog.text
    assert "Invalid subjectId" in caplog.text
    assert "Invalid request.maxContextBytes" in caplog.text


def test_env_config_when_no_config_file_is_set(monkeypatch):
    monkeypatch.delenv("DENIED_CONFIG", raising=False)
    monkeypatch.delenv("DENIED_HERMES_CONFIG", raising=False)
    monkeypatch.setenv("DENIED_API_KEY", "env-api-key")
    monkeypatch.setenv("DENIED_URL", "https://env-pdp.test")
    monkeypatch.setenv("DENIED_FAIL_MODE", "closed")

    resolved = resolve_config()

    assert resolved.api_key == "env-api-key"
    assert resolved.url == "https://env-pdp.test"
    assert resolved.fail_mode == "closed"


def test_allows_authorized_tool_call():
    client = FakeClient(
        CheckResponse(
            decision=True,
            context=CheckResponseContext(
                reason="Read-only shell commands are allowed.",
                rules=None,
            ),
        )
    )
    plugin = DeniedHermesPlugin(config(), client)

    result = plugin.pre_tool_call(
        tool_name="terminal",
        args={"command": "ls -la", "github_token": "secret-token"},
        task_id="task-1",
        cwd="/workspace/project",
        tool_call_id="tool-1",
        session_id="sess-1",
    )

    assert result is None
    request = client.calls[0]
    assert request["subject"].type == "hermes-agent"
    assert request["subject"].id == "sess-1"
    assert request["action"].name == "run_command"
    assert request["action"].properties == {
        "effect": "read",
        "tool_name": "terminal",
        "capability": "shell.command",
    }
    assert request["resource"].type == "command"
    assert request["resource"].id == "ls"
    assert request["resource"].properties["command"] == "ls -la"
    assert (
        request["resource"].properties["raw_tool"]["input"]["github_token"]
        == "[REDACTED]"
    )
    assert request["context"]["integration"] == "denied-hermes-shell-hook"
    assert (
        request["context"]["hook_payload"]["tool_input"]["github_token"] == "[REDACTED]"
    )


def test_blocks_denied_tool_call():
    client = FakeClient(
        CheckResponse(
            decision=False,
            context=CheckResponseContext(
                reason="Shell deletes are not allowed.",
                rules=None,
            ),
        )
    )
    plugin = DeniedHermesPlugin(config(), client)

    result = plugin.pre_tool_call(
        tool_name="terminal",
        args={"command": "rm -rf tmp"},
        task_id="task-2",
        cwd="/workspace/project",
    )

    assert result == {
        "action": "block",
        "message": "Shell deletes are not allowed.",
    }
    request = client.calls[0]
    assert request["action"].properties["effect"] == "delete"
    assert request["resource"].id == "rm"


@pytest.mark.parametrize(
    ("command", "effect"),
    [
        ("rm -rf tmp 2>/dev/null", "delete"),
        ("rm -rf tmp > /dev/null", "delete"),
        ("rm -rf tmp 2>&1", "delete"),
        ("sed -i s/a/b/ file >/dev/null", "update"),
        ("chmod 600 file >/dev/null", "update"),
        ("echo hello > file.txt", "create"),
        ("ls -la", "read"),
    ],
)
def test_infers_shell_effect(command: str, effect: str):
    assert infer_shell_effect(command) == effect


def test_fail_closed_blocks_when_pdp_unavailable():
    plugin = DeniedHermesPlugin(
        config(fail_mode="closed"),
        FakeClient(RuntimeError("fetch failed")),
    )

    result = plugin.pre_tool_call(
        tool_name="terminal",
        args={"command": "date"},
        task_id="task-3",
    )

    assert result is not None
    assert result["action"] == "block"
    assert "fail-mode is closed" in result["message"]


def test_fail_open_allows_when_pdp_unavailable():
    plugin = DeniedHermesPlugin(
        config(fail_mode="open"),
        FakeClient(RuntimeError("fetch failed")),
    )

    result = plugin.pre_tool_call(
        tool_name="terminal",
        args={"command": "date"},
        task_id="task-3",
    )

    assert result is None


def test_missing_api_key_honors_fail_mode():
    plugin = DeniedHermesPlugin(
        config(api_key="", fail_mode="closed"),
        FakeClient(CheckResponse(decision=True, context=None)),
    )

    result = plugin.pre_tool_call(tool_name="terminal", args={"command": "date"})

    assert result is not None
    assert result["action"] == "block"
    assert "DENIED_API_KEY/apiKey is not set" in result["message"]


def test_request_config_omits_hook_payload_and_tool_input():
    client = FakeClient(CheckResponse(decision=True, context=None))
    plugin = DeniedHermesPlugin(
        config(include_hook_payload=False, include_tool_input=False),
        client,
    )

    plugin.pre_tool_call(
        tool_name="terminal",
        args={"command": "ls -la", "github_token": "secret-token"},
        task_id="task-5",
    )

    assert "hook_payload" not in client.calls[0]["context"]
    assert client.calls[0]["resource"].properties["raw_tool"] == {"name": "terminal"}


def test_redacts_inline_command_secrets_and_audit_records(tmp_path: Path):
    command = (
        "curl -H 'Authorization: Bearer bearer-secret' "
        "--api-key cli-secret https://example.test TOKEN=env-secret"
    )
    client = FakeClient(CheckResponse(decision=True, context=None))
    plugin = DeniedHermesPlugin(
        config(audit=AuditConfig(enabled=True, dir=tmp_path)),
        client,
    )

    plugin.pre_tool_call(
        tool_name="terminal",
        args={"command": command, "github_token": "field-secret"},
        task_id="task-redact",
    )

    request_body = json.dumps(client.calls[0], default=lambda value: value.model_dump())
    audit_body = (tmp_path / "denied-hermes-hook.jsonl").read_text(encoding="utf-8")
    assert "bearer-secret" not in request_body
    assert "cli-secret" not in request_body
    assert "env-secret" not in request_body
    assert "field-secret" not in request_body
    assert "bearer-secret" not in audit_body
    assert "cli-secret" not in audit_body
    assert "env-secret" not in audit_body
    assert "field-secret" not in audit_body


def test_audit_include_flags_control_record_sections(tmp_path: Path):
    plugin = DeniedHermesPlugin(
        config(
            audit=AuditConfig(
                enabled=True,
                dir=tmp_path,
                include_raw_payload=False,
                include_mapped_request=True,
                include_decision=False,
            )
        ),
        FakeClient(CheckResponse(decision=True, context=None)),
    )

    plugin.pre_tool_call(
        tool_name="terminal",
        args={"command": "date"},
        task_id="task-audit-flags",
    )

    audit_record = json.loads(
        (tmp_path / "denied-hermes-hook.jsonl").read_text(encoding="utf-8")
    )
    assert set(audit_record) == {"timestamp", "mapped_request"}


def test_honors_redaction_disabled():
    client = FakeClient(CheckResponse(decision=True, context=None))
    plugin = DeniedHermesPlugin(config(redaction_enabled=False), client)

    plugin.pre_tool_call(
        tool_name="terminal",
        args={
            "command": "curl --token secret-token https://example.test",
            "github_token": "secret-token",
        },
        task_id="task-6",
    )

    resource = client.calls[0]["resource"]
    assert resource.properties["raw_tool"]["input"]["github_token"] == "secret-token"
    assert (
        resource.properties["command"]
        == "curl --token secret-token https://example.test"
    )


def test_truncates_oversized_context_values():
    client = FakeClient(CheckResponse(decision=True, context=None))
    plugin = DeniedHermesPlugin(config(max_context_bytes=120), client)

    plugin.pre_tool_call(
        tool_name="terminal",
        args={"command": f"echo {'x' * 500}", "payload": "y" * 500},
        task_id="task-large",
    )

    resource = client.calls[0]["resource"]
    assert resource.properties["command"]["truncated"] is True
    assert resource.properties["raw_tool"]["input"]["truncated"] is True
    assert client.calls[0]["context"]["hook_payload"]["truncated"] is True


def test_redacts_circular_payload_without_recursing_forever():
    payload: dict[str, Any] = {"token": "secret-token"}
    payload["self"] = payload

    redacted = redact_value(payload, ["token"])

    assert redacted["token"] == "[REDACTED]"
    assert redacted["self"] == "[Circular]"


def test_redacts_circular_list_without_recursing_forever():
    payload: list[Any] = ["secret-token"]
    payload.append(payload)

    redacted = redact_value(payload, ["token"])

    assert redacted == ["secret-token", "[Circular]"]


def test_truncate_json_value_limits_preview_by_bytes():
    value = {"message": "😀" * 20}
    max_bytes = 20
    raw = json.dumps(value, separators=(",", ":"), default=str, ensure_ascii=False)

    truncated = truncate_json_value(value, max_bytes)

    assert truncated["truncated"] is True
    assert truncated["preview"] == raw.encode("utf-8")[:max_bytes].decode(
        "utf-8", errors="replace"
    )
    assert truncated["preview"] != raw[:max_bytes]


def test_uses_generic_tool_resources_when_semantic_mapping_disabled():
    client = FakeClient(CheckResponse(decision=True, context=None))
    plugin = DeniedHermesPlugin(config(use_semantic_mapping=False), client)

    plugin.pre_tool_call(
        tool_name="terminal",
        args={"command": "ls -la"},
        task_id="task-7",
    )

    resource = client.calls[0]["resource"]
    action = client.calls[0]["action"]
    assert resource.type == "tool"
    assert resource.id == "terminal"
    assert action.properties["capability"] == "tool.call"
    assert "command" not in resource.properties


@pytest.mark.parametrize(
    ("subject_id", "expected"),
    [("task", "task-8"), ("tool_call", "tool-8")],
)
def test_subject_id_modes(subject_id: str, expected: str):
    mapper = ContextMapper(config(subject_id=subject_id))
    payload = payload_from_hook(
        "terminal",
        {"command": "ls -la"},
        "task-8",
        tool_call_id="tool-8",
        session_id="sess-8",
    )

    request = mapper.create_check_request(payload)

    assert request.subject.id == expected


def test_maps_file_url_and_web_search_resources():
    mapper = ContextMapper(config())

    file_request = mapper.create_check_request(
        payload_from_hook("read_file", {"path": "README.md"}, "task", cwd="/repo")
    )
    url_request = mapper.create_check_request(
        payload_from_hook("webfetch", {"url": "https://example.test"}, "task")
    )
    search_request = mapper.create_check_request(
        payload_from_hook("web_search", {"query": "denied"}, "task")
    )

    assert file_request.resource.type == "file"
    assert file_request.resource.properties["path"] == "README.md"
    assert url_request.resource.type == "url"
    assert url_request.resource.id == "https://example.test"
    assert search_request.resource.type == "web-search"


def test_maps_http_method_to_operation_and_preserves_method_property():
    mapper = ContextMapper(config())

    request = mapper.create_check_request(
        payload_from_hook(
            "api_request",
            {"method": "POST", "endpoint": "https://api.example.test/items"},
            "task-http",
        )
    )

    assert request.action.name == "http_post"
    assert request.resource.type == "url"
    assert request.resource.properties["method"] == "POST"


def test_resolves_relative_file_resource_from_cwd():
    mapper = ContextMapper(config())

    request = mapper.create_check_request(
        payload_from_hook(
            "read_file", {"file_path": "src/app.py"}, "task-file", cwd="/repo"
        )
    )

    assert request.resource.type == "file"
    assert request.resource.id == "/repo/src/app.py"


def test_close_closes_injected_client():
    client = FakeClient(CheckResponse(decision=True, context=None))
    plugin = DeniedHermesPlugin(config(), client)

    plugin.close()

    assert client.closed is True
