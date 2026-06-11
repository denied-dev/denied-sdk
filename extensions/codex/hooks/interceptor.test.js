// Tests for the Codex interceptor pure logic.
// Run with: node --test (Node 18+, zero dependencies).

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  resolveConfigPath,
  loadFileConfig,
  resolveConfig,
  truncateJsonValue,
  buildCheckBody,
  appendAuditRecord,
  interpretDecision,
  resolveFailSafe,
  buildDenyOutput,
} = require("./interceptor.js");

test("resolveConfigPath defaults to ~/.denied/config.json", () => {
  assert.equal(
    resolveConfigPath({}, "/home/dev"),
    path.join("/home/dev", ".denied", "config.json"),
  );
});

test("resolveConfigPath honors the DENIED_CONFIG override", () => {
  assert.equal(
    resolveConfigPath({ DENIED_CONFIG: "/etc/denied.json" }, "/home/dev"),
    "/etc/denied.json",
  );
});

test("loadFileConfig returns {} when the file is missing", () => {
  const missing = path.join(os.tmpdir(), `denied-missing-${Date.now()}.json`);
  assert.deepEqual(loadFileConfig(missing), {});
});

test("loadFileConfig parses a valid JSON file", () => {
  const file = path.join(os.tmpdir(), `denied-cfg-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ apiKey: "dn_file", url: "https://f" }));
  try {
    assert.deepEqual(loadFileConfig(file), { apiKey: "dn_file", url: "https://f" });
  } finally {
    fs.unlinkSync(file);
  }
});

test("loadFileConfig warns and returns {} on malformed JSON", () => {
  const file = path.join(os.tmpdir(), `denied-bad-${Date.now()}.json`);
  fs.writeFileSync(file, "{ not json");
  let warned = "";
  try {
    assert.deepEqual(loadFileConfig(file, (m) => (warned = m)), {});
    assert.match(warned, /malformed config file/);
  } finally {
    fs.unlinkSync(file);
  }
});

test("resolveConfig falls back to defaults with no env or file", () => {
  assert.deepEqual(resolveConfig({}, {}), {
    url: "https://api.denied.dev",
    apiKey: "",
    failMode: "open",
    timeoutMs: 15000,
    includeToolInput: true,
    includeHookPayload: true,
    maxContextBytes: 20000,
    audit: {
      enabled: false,
      dir: path.join(os.homedir(), ".denied", "audit"),
      includeRawPayload: true,
      includeMappedRequest: true,
      includeDecision: true,
    },
  });
});

test("resolveConfig reads values from the file when env is absent", () => {
  const cfg = resolveConfig(
    {},
    { apiKey: "dn_file", url: "https://file", failMode: "CLOSED", timeoutMs: 5000 },
  );
  assert.equal(cfg.apiKey, "dn_file");
  assert.equal(cfg.url, "https://file");
  assert.equal(cfg.failMode, "closed");
  assert.equal(cfg.timeoutMs, 5000);
});

test("resolveConfig lets environment variables override the file", () => {
  const cfg = resolveConfig(
    {
      DENIED_API_KEY: "dn_env",
      DENIED_URL: "https://env",
      DENIED_FAIL_MODE: "closed",
      DENIED_TIMEOUT_MS: "1000",
    },
    { apiKey: "dn_file", url: "https://file", failMode: "open", timeoutMs: 5000 },
  );
  assert.equal(cfg.url, "https://env");
  assert.equal(cfg.apiKey, "dn_env");
  assert.equal(cfg.failMode, "closed");
  assert.equal(cfg.timeoutMs, 1000);
});

test("resolveConfig ignores a non-numeric DENIED_TIMEOUT_MS and uses the file value", () => {
  assert.equal(resolveConfig({ DENIED_TIMEOUT_MS: "abc" }, { timeoutMs: 7000 }).timeoutMs, 7000);
});

test("buildCheckBody maps a full input to an AuthZEN request", () => {
  const body = buildCheckBody({
    session_id: "sess-1",
    cwd: "/work",
    permission_mode: "ask",
    model: "gpt-5-codex",
    tool_name: "shell",
    tool_input: { command: "ls" },
    tool_use_id: "use-1",
  });

  assert.deepEqual(body, {
    subject: {
      type: "codex",
      id: "sess-1",
      properties: {
        cwd: "/work",
        permission_mode: "ask",
        model: "gpt-5-codex",
      },
    },
    action: { name: "execute" },
    resource: {
      type: "tool",
      id: "shell",
      properties: {
        tool_input: { command: "ls" },
        tool_use_id: "use-1",
      },
    },
    context: {
      integration: "denied-codex-hook",
      hook_event_name: undefined,
      authz_direction: "agent-to-world",
      hook_payload: {
        session_id: "sess-1",
        cwd: "/work",
        permission_mode: "ask",
        model: "gpt-5-codex",
        tool_name: "shell",
        tool_input: { command: "ls" },
        tool_use_id: "use-1",
      },
    },
  });
});

test("buildCheckBody fills defaults for missing fields", () => {
  const body = buildCheckBody({});

  assert.equal(body.subject.type, "codex");
  assert.equal(body.subject.id, "unknown");
  assert.equal(body.subject.properties.cwd, "unknown");
  assert.equal(body.subject.properties.permission_mode, "unknown");
  assert.equal(body.subject.properties.model, "unknown");
  assert.equal(body.resource.id, "unknown");
  assert.deepEqual(body.resource.properties.tool_input, {});
  assert.equal(body.resource.properties.tool_use_id, "unknown");
  assert.equal(body.context.integration, "denied-codex-hook");
});

test("buildCheckBody honors request context flags", () => {
  const body = buildCheckBody(
    { tool_input: { command: "ls" }, tool_use_id: "use-1" },
    {
      includeToolInput: false,
      includeHookPayload: false,
      maxContextBytes: 20000,
    },
  );

  assert.deepEqual(body.resource.properties, { tool_use_id: "use-1" });
  assert.equal("hook_payload" in body.context, false);
});

test("truncateJsonValue returns a Hermes-style preview for oversized values", () => {
  const value = truncateJsonValue({ command: "x".repeat(50) }, 20);

  assert.equal(value.truncated, true);
  assert.equal(value.max_bytes, 20);
  assert.equal(typeof value.original_bytes, "number");
  assert.equal(typeof value.preview, "string");
});

test("appendAuditRecord writes configured sections", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "denied-codex-audit-"));
  try {
    appendAuditRecord(
      { tool_input: { command: "ls" } },
      { resource: { id: "shell" } },
      { decision: true },
      {
        maxContextBytes: 20000,
        audit: {
          enabled: true,
          dir,
          includeRawPayload: true,
          includeMappedRequest: false,
          includeDecision: true,
        },
      },
    );
    const record = JSON.parse(
      fs.readFileSync(path.join(dir, "denied-codex-hook.jsonl"), "utf-8"),
    );
    assert.deepEqual(Object.keys(record).sort(), [
      "decision",
      "hook_payload",
      "timestamp",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("interpretDecision allows on decision === true", () => {
  assert.deepEqual(interpretDecision({ decision: true }), {
    kind: "allow",
    reason: "Authorization allowed by Denied policy engine.",
  });
});

test("interpretDecision denies on decision === false", () => {
  assert.deepEqual(interpretDecision({ decision: false }), {
    kind: "deny",
    reason: "Authorization denied by Denied policy engine.",
  });
});

test("interpretDecision prefers the context reason when present", () => {
  assert.equal(
    interpretDecision({ decision: false, context: { reason: "blocked: rm" } })
      .reason,
    "blocked: rm",
  );
  assert.equal(
    interpretDecision({ decision: true, context: { reason: "ok: read" } })
      .reason,
    "ok: read",
  );
});

test("interpretDecision errors on a missing or non-boolean decision", () => {
  assert.equal(interpretDecision({}).kind, "error");
  assert.equal(interpretDecision({ decision: "yes" }).kind, "error");
  assert.equal(interpretDecision({ decision: null }).kind, "error");
});

test("resolveFailSafe denies when fail mode is closed", () => {
  const outcome = resolveFailSafe("closed", "boom");
  assert.equal(outcome.kind, "deny");
  assert.match(outcome.reason, /fail-mode is closed\. boom/);
});

test("resolveFailSafe allows for open or any non-closed mode", () => {
  assert.equal(resolveFailSafe("open", "boom").kind, "allow");
  assert.equal(resolveFailSafe("whatever", "boom").kind, "allow");
});

test("buildDenyOutput shapes the Codex PreToolUse payload", () => {
  assert.deepEqual(buildDenyOutput("nope"), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "nope",
    },
  });
});
