// Tests for the Claude Code interceptor pure logic.
// Run with: node --test (Node 18+, zero dependencies).

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");

const {
  resolveConfigPath,
  loadFileConfig,
  loadRuntimeConfig,
  resolveConfig,
  truncateJsonValue,
  buildCheckBody,
  appendAuditRecord,
  interpretDecision,
  resolveFailSafe,
  buildDecisionOutput,
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

test("loadFileConfig parses a valid JSON file", async () => {
  const file = path.join(os.tmpdir(), `denied-claude-cfg-${Date.now()}.json`);
  await fs.writeFile(file, JSON.stringify({ apiKey: "dn_file", url: "https://f" }));
  try {
    assert.deepEqual(await loadFileConfig(file), { apiKey: "dn_file", url: "https://f" });
  } finally {
    await fs.unlink(file);
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

test("resolveConfig ignores a non-string file failMode", () => {
  assert.equal(resolveConfig({}, { failMode: 42 }).failMode, "open");
});

test("loadRuntimeConfig resolves config from the async file loader", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "denied-claude-config-"));
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, JSON.stringify({ apiKey: "dn_file", failMode: "closed" }));
  try {
    const cfg = await loadRuntimeConfig({ DENIED_CONFIG: file }, os.homedir());
    assert.equal(cfg.apiKey, "dn_file");
    assert.equal(cfg.failMode, "closed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildCheckBody maps a full input to an AuthZEN request", () => {
  const body = buildCheckBody({
    session_id: "sess-1",
    cwd: "/work",
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_use_id: "use-1",
  });

  assert.deepEqual(body, {
    subject: {
      type: "claude-code",
      id: "sess-1",
      properties: { cwd: "/work", permission_mode: "default" },
    },
    action: { name: "execute" },
    resource: {
      type: "tool",
      id: "Bash",
      properties: {
        tool_input: { command: "ls" },
        tool_use_id: "use-1",
      },
    },
    context: {
      integration: "denied-claude-code-hook",
      hook_event_name: undefined,
      authz_direction: "agent-to-world",
      hook_payload: {
        session_id: "sess-1",
        cwd: "/work",
        permission_mode: "default",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "use-1",
      },
    },
  });
});

test("buildCheckBody fills defaults for missing fields", () => {
  const body = buildCheckBody({});

  assert.equal(body.subject.type, "claude-code");
  assert.equal(body.subject.id, "unknown");
  assert.equal(body.subject.properties.cwd, "unknown");
  assert.equal(body.subject.properties.permission_mode, "unknown");
  assert.equal(body.resource.id, "unknown");
  assert.deepEqual(body.resource.properties.tool_input, {});
  assert.equal(body.resource.properties.tool_use_id, "unknown");
  assert.equal(body.context.integration, "denied-claude-code-hook");
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

test("truncateJsonValue caps previews by UTF-8 byte length", () => {
  const value = truncateJsonValue({ command: "😀".repeat(20) }, 15);

  assert.equal(value.truncated, true);
  assert.equal(Buffer.byteLength(value.preview, "utf-8") <= value.max_bytes, true);
  assert.equal(value.preview.includes("\uFFFD"), false);
});

test("appendAuditRecord writes configured sections", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "denied-claude-audit-"));
  try {
    await appendAuditRecord(
      { tool_input: { command: "ls" } },
      { resource: { id: "Bash" } },
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
      await fs.readFile(path.join(dir, "denied-claude-code-hook.jsonl"), "utf-8"),
    );
    assert.deepEqual(Object.keys(record).sort(), [
      "decision",
      "hook_payload",
      "timestamp",
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
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

test("buildDecisionOutput shapes the allow payload", () => {
  assert.deepEqual(buildDecisionOutput("allow", "ok"), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "ok",
    },
  });
});

test("buildDecisionOutput shapes the deny payload", () => {
  assert.deepEqual(buildDecisionOutput("deny", "nope"), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "nope",
    },
  });
});
