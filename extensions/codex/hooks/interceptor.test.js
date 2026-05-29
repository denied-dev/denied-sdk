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
  buildCheckBody,
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
  assert.deepEqual(cfg, {
    url: "https://env",
    apiKey: "dn_env",
    failMode: "closed",
    timeoutMs: 1000,
  });
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
