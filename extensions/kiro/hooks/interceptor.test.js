// Tests for the Kiro interceptor pure logic.
// Run with: node --test (Node 18+, zero dependencies).

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");

const {
  EXIT_ALLOW,
  EXIT_DENY,
  SURFACE_V1,
  SURFACE_CLI_V2,
  resolveConfigPath,
  loadFileConfig,
  loadRuntimeConfig,
  resolveConfig,
  resolveSurface,
  parseHookPayload,
  normalizeToolName,
  resolveSubjectId,
  payloadFidelity,
  redactKeys,
  truncateJsonValue,
  buildCheckBody,
  appendAuditRecord,
  interpretDecision,
  resolveFailSafe,
  resolveExitCode,
} = require("./interceptor.js");

// Resolved from an empty environment so the developer's own DENIED_* variables
// cannot leak into the expected request bodies.
const TEST_CONFIG = resolveConfig({}, {});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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

test("loadFileConfig returns {} when the file is missing", async () => {
  const missing = path.join(os.tmpdir(), `denied-missing-${Date.now()}.json`);
  assert.deepEqual(await loadFileConfig(missing), {});
});

test("loadFileConfig parses a valid JSON file", async () => {
  const file = path.join(os.tmpdir(), `denied-kiro-cfg-${Date.now()}.json`);
  await fs.writeFile(file, JSON.stringify({ apiKey: "dn_file", url: "https://f" }));
  try {
    assert.deepEqual(await loadFileConfig(file), { apiKey: "dn_file", url: "https://f" });
  } finally {
    await fs.unlink(file);
  }
});

test("loadFileConfig warns and returns {} on malformed JSON", async () => {
  const file = path.join(os.tmpdir(), `denied-kiro-bad-${Date.now()}.json`);
  await fs.writeFile(file, "{ not json");
  let warned = "";
  try {
    assert.deepEqual(await loadFileConfig(file, (m) => (warned = m)), {});
    assert.match(warned, /malformed config file/);
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
    redaction: {
      enabled: true,
      keys: ["api_key", "apikey", "authorization", "password", "secret", "token"],
    },
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

test("resolveConfig rejects a zero or negative timeout at every tier", () => {
  // A non-positive timeout would abort every PDP call before it completes —
  // a gate that silently never enforces.
  assert.equal(resolveConfig({ DENIED_TIMEOUT_MS: "0" }, {}).timeoutMs, 15000);
  assert.equal(resolveConfig({ DENIED_TIMEOUT_MS: "-5" }, { timeoutMs: 7000 }).timeoutMs, 7000);
  assert.equal(resolveConfig({}, { timeoutMs: 0 }).timeoutMs, 15000);
  assert.equal(resolveConfig({}, { timeoutMs: -1 }).timeoutMs, 15000);
});

test("resolveConfig ignores a non-string file failMode", () => {
  assert.equal(resolveConfig({}, { failMode: 42 }).failMode, "open");
});

test("resolveConfig reads the request block", () => {
  const cfg = resolveConfig(
    {},
    {
      request: {
        includeToolInput: false,
        includeHookPayload: false,
        maxContextBytes: 128,
      },
    },
  );
  assert.equal(cfg.includeToolInput, false);
  assert.equal(cfg.includeHookPayload, false);
  assert.equal(cfg.maxContextBytes, 128);
});

test("resolveConfig ignores a non-positive maxContextBytes", () => {
  assert.equal(resolveConfig({}, { request: { maxContextBytes: 0 } }).maxContextBytes, 20000);
  assert.equal(resolveConfig({}, { request: { maxContextBytes: -5 } }).maxContextBytes, 20000);
});

test("resolveConfig lets the file disable redaction and replace the key list", () => {
  const off = resolveConfig({}, { redaction: { enabled: false } });
  assert.equal(off.redaction.enabled, false);

  const custom = resolveConfig({}, { redaction: { keys: ["ssn", 7, ""] } });
  assert.deepEqual(custom.redaction.keys, ["ssn"]);
});

test("resolveConfig falls back to the default keys when the file list is unusable", () => {
  assert.equal(resolveConfig({}, { redaction: { keys: "token" } }).redaction.keys.length, 6);
  assert.equal(resolveConfig({}, { redaction: { keys: [] } }).redaction.keys.length, 6);
});

test("loadRuntimeConfig resolves config from the async file loader", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "denied-kiro-config-"));
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

// ---------------------------------------------------------------------------
// Surface and stdin
// ---------------------------------------------------------------------------

test("resolveSurface defaults to the shared IDE/CLI-V3 surface", () => {
  assert.equal(resolveSurface([]), SURFACE_V1);
  assert.equal(resolveSurface(["--surface=ide"]), SURFACE_V1);
  assert.equal(resolveSurface(["--surface="]), SURFACE_V1);
  assert.equal(resolveSurface(["--verbose"]), SURFACE_V1);
});

test("resolveSurface selects cli-v2 only for the explicit flag", () => {
  assert.equal(resolveSurface(["--surface=cli-v2"]), SURFACE_CLI_V2);
  assert.equal(resolveSurface(["--other", "--surface=cli-v2"]), SURFACE_CLI_V2);
});

test("parseHookPayload resolves an absent or unusable payload to {}", () => {
  assert.deepEqual(parseHookPayload(""), {});
  assert.deepEqual(parseHookPayload("   \n"), {});
  assert.deepEqual(parseHookPayload("{ not json"), {});
  assert.deepEqual(parseHookPayload("[1,2]"), {});
  assert.deepEqual(parseHookPayload("null"), {});
  assert.deepEqual(parseHookPayload(undefined), {});
});

test("parseHookPayload parses a well-formed hook payload", () => {
  assert.deepEqual(parseHookPayload('{"tool_name":"read_file"}'), {
    tool_name: "read_file",
  });
});

// ---------------------------------------------------------------------------
// Tool-name normalization
// ---------------------------------------------------------------------------

test("normalizeToolName is the identity on the supported surfaces", () => {
  for (const name of [
    "read_file",
    "fs_write",
    "execute_bash",
    "grep_search",
    "web_fetch",
    "orchestrate_subagent",
    "invoke_sub_agent",
    "read",
    "shell",
  ]) {
    assert.equal(normalizeToolName(name, SURFACE_V1), name);
    assert.equal(normalizeToolName(name), name);
  }
});

test("normalizeToolName maps the CLI V2 vocabulary onto the V3/IDE names", () => {
  const table = [
    ["read", "read_file"],
    ["fs_read", "read_file"],
    ["fsRead", "read_file"],
    ["write", "fs_write"],
    ["fs_write", "fs_write"],
    ["fsWrite", "fs_write"],
    ["shell", "execute_bash"],
    ["execute_bash", "execute_bash"],
    ["execute_cmd", "execute_bash"],
    ["grep", "grep_search"],
    ["use_aws", "aws"],
    ["aws", "aws"],
    ["use_subagent", "subagent"],
    ["subagent", "subagent"],
  ];
  for (const [input, expected] of table) {
    assert.equal(normalizeToolName(input, SURFACE_CLI_V2), expected, input);
  }
});

test("normalizeToolName passes through names with no V3 equivalent", () => {
  // Only CLI V2 has a real glob tool; on the supported surfaces pattern
  // matching compiles down to execute_bash + find.
  assert.equal(normalizeToolName("glob", SURFACE_CLI_V2), "glob");
  assert.equal(normalizeToolName("knowledge", SURFACE_CLI_V2), "knowledge");
  assert.equal(normalizeToolName("some_future_tool", SURFACE_CLI_V2), "some_future_tool");
});

test("normalizeToolName leaves MCP @server/tool names intact", () => {
  assert.equal(normalizeToolName("@postgres/query", SURFACE_CLI_V2), "@postgres/query");
  assert.equal(normalizeToolName("@postgres/read", SURFACE_CLI_V2), "@postgres/read");
  assert.equal(normalizeToolName("@postgres", SURFACE_V1), "@postgres");
});

test("normalizeToolName does not resolve inherited object properties", () => {
  assert.equal(normalizeToolName("constructor", SURFACE_CLI_V2), "constructor");
  assert.equal(normalizeToolName("__proto__", SURFACE_CLI_V2), "__proto__");
  assert.equal(normalizeToolName("toString", SURFACE_CLI_V2), "toString");
});

test("normalizeToolName returns unknown for an absent tool name", () => {
  assert.equal(normalizeToolName(undefined, SURFACE_V1), "unknown");
  assert.equal(normalizeToolName("", SURFACE_CLI_V2), "unknown");
  assert.equal(normalizeToolName(42, SURFACE_V1), "unknown");
});

// ---------------------------------------------------------------------------
// Subject identity
// ---------------------------------------------------------------------------

test("resolveSubjectId prefers a non-empty session_id", () => {
  assert.deepEqual(resolveSubjectId({ session_id: "sess-1" }, 4242, "/work"), {
    id: "sess-1",
    source: "session_id",
  });
});

test("resolveSubjectId falls back to a stable per-process id", () => {
  const first = resolveSubjectId({ cwd: "/work" }, 4242, "/work");
  const second = resolveSubjectId({ cwd: "/work" }, 4242, "/work");

  assert.equal(first.source, "process");
  assert.match(first.id, /^kiro-[0-9a-f]{12}$/);
  // Stability is the point: a random per-invocation id would make every tool
  // call look like its own session.
  assert.equal(first.id, second.id);
});

test("resolveSubjectId derives different ids for different processes or roots", () => {
  const a = resolveSubjectId({}, 4242, "/work");
  const b = resolveSubjectId({}, 9999, "/work");
  const c = resolveSubjectId({}, 4242, "/other");

  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, c.id);
});

test("resolveSubjectId treats a blank or non-string session_id as absent", () => {
  assert.equal(resolveSubjectId({ session_id: "   " }, 4242, "/work").source, "process");
  assert.equal(resolveSubjectId({ session_id: 7 }, 4242, "/work").source, "process");
});

test("resolveSubjectId degrades to unknown when no process id is available", () => {
  assert.deepEqual(resolveSubjectId({}, undefined, undefined), {
    id: "unknown",
    source: "none",
  });
  assert.deepEqual(resolveSubjectId({}, 0, "/work"), { id: "unknown", source: "none" });
});

// ---------------------------------------------------------------------------
// Payload fidelity
// ---------------------------------------------------------------------------

test("payloadFidelity reports full for a tool name and populated arguments", () => {
  assert.equal(
    payloadFidelity({ tool_name: "fs_write", tool_input: { path: "/a", text: "b" } }),
    "full",
  );
});

test("payloadFidelity reports tool_name_only for an empty or absent tool_input", () => {
  assert.equal(payloadFidelity({ tool_name: "execute_bash" }), "tool_name_only");
  assert.equal(payloadFidelity({ tool_name: "execute_bash", tool_input: {} }), "tool_name_only");
  assert.equal(payloadFidelity({ tool_name: "execute_bash", tool_input: [] }), "tool_name_only");
  assert.equal(payloadFidelity({ tool_name: "execute_bash", tool_input: null }), "tool_name_only");
});

test("payloadFidelity reports none when the tool name is missing", () => {
  assert.equal(payloadFidelity({}), "none");
  assert.equal(payloadFidelity({ session_id: "sess-1" }), "none");
  assert.equal(payloadFidelity({ tool_name: "", tool_input: { path: "/a" } }), "none");
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("redactKeys replaces sensitive values and leaves the rest alone", () => {
  const input = { path: "/etc/hosts", token: "dn_live_123" };
  assert.deepEqual(redactKeys(input), { path: "/etc/hosts", token: "[REDACTED]" });
});

test("redactKeys matches keys case-insensitively and across punctuation", () => {
  const input = {
    Authorization: "Bearer x",
    "X-API-Key": "k",
    apiKey: "k",
    api_key: "k",
    PASSWORD: "p",
  };
  assert.deepEqual(redactKeys(input), {
    Authorization: "[REDACTED]",
    "X-API-Key": "[REDACTED]",
    apiKey: "[REDACTED]",
    api_key: "[REDACTED]",
    PASSWORD: "[REDACTED]",
  });
});

test("redactKeys recurses into nested objects and arrays", () => {
  const input = {
    tool_input: {
      env: [{ name: "HOME", secret: "s" }, { password: "p" }],
      nested: { deep: { authorization: "a", keep: 1 } },
    },
  };
  assert.deepEqual(redactKeys(input), {
    tool_input: {
      env: [{ name: "HOME", secret: "[REDACTED]" }, { password: "[REDACTED]" }],
      nested: { deep: { authorization: "[REDACTED]", keep: 1 } },
    },
  });
});

test("redactKeys is non-destructive and leaves unmatched input untouched", () => {
  const input = { a: { b: [1, 2, "three"] }, n: null, t: true };
  const output = redactKeys(input);

  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.notEqual(output.a, input.a);
  input.a.b.push(4);
  assert.equal(output.a.b.length, 3);
});

test("redactKeys terminates on cycles without redacting repeated siblings", () => {
  const cycle = { name: "root" };
  cycle.self = cycle;
  assert.deepEqual(redactKeys(cycle), { name: "root", self: "[Circular]" });

  const shared = { token: "t" };
  assert.deepEqual(redactKeys({ first: shared, second: shared }), {
    first: { token: "[REDACTED]" },
    second: { token: "[REDACTED]" },
  });
});

test("redactKeys bounds recursion depth instead of overflowing the stack", () => {
  // A stack overflow here would fire before main()'s try/catch and skip the
  // PDP call entirely, degrading every deep payload to failMode.
  let deep = { leaf: true };
  for (let i = 0; i < 60_000; i += 1) {
    deep = { nested: deep };
  }
  const redacted = redactKeys(deep);
  assert.equal(JSON.stringify(redacted).includes("[MaxDepth]"), true);
});

test("redactKeys preserves a literal __proto__ key as plain data", () => {
  const input = JSON.parse('{"__proto__": {"a": 1}, "b": 2}');
  const redacted = redactKeys(input);
  assert.equal(JSON.stringify(redacted), '{"__proto__":{"a":1},"b":2}');
  assert.equal({}.a, undefined);
});

test("redactKeys honors a custom key list", () => {
  assert.deepEqual(redactKeys({ ssn: "1", token: "t" }, ["ssn"]), {
    ssn: "[REDACTED]",
    token: "t",
  });
});

test("redactKeys passes primitives through unchanged", () => {
  assert.equal(redactKeys("plain"), "plain");
  assert.equal(redactKeys(7), 7);
  assert.equal(redactKeys(null), null);
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

test("truncateJsonValue returns the value unchanged at the byte boundary", () => {
  const value = { a: "bc" };
  const raw = JSON.stringify(value);
  assert.deepEqual(truncateJsonValue(value, Buffer.byteLength(raw, "utf-8")), value);
  assert.equal(truncateJsonValue(value, Buffer.byteLength(raw, "utf-8") - 1).truncated, true);
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
  assert.equal(value.preview.includes("�"), false);
});

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

test("buildCheckBody maps a full payload to an AuthZEN request", () => {
  const input = {
    hook_event_name: "PreToolUse",
    cwd: "/work",
    session_id: "sess-1",
    tool_name: "execute_bash",
    tool_input: { command: "ls", cwd: "/work" },
  };
  const body = buildCheckBody(input, TEST_CONFIG, SURFACE_V1, {
    id: "sess-1",
    source: "session_id",
  });

  assert.deepEqual(body, {
    subject: {
      type: "kiro",
      id: "sess-1",
      properties: {
        cwd: "/work",
        surface: "kiro-v1",
        session_id_source: "session_id",
      },
    },
    action: { name: "execute" },
    resource: {
      type: "tool",
      id: "execute_bash",
      properties: {
        tool_name_canonical: "execute_bash",
        tool_input: { command: "ls", cwd: "/work" },
      },
    },
    context: {
      integration: "denied-kiro-hook",
      hook_event_name: "PreToolUse",
      authz_direction: "agent-to-world",
      payload_fidelity: "full",
      hook_payload: {
        hook_event_name: "PreToolUse",
        cwd: "/work",
        session_id: "sess-1",
        tool_name: "execute_bash",
        tool_input: { command: "ls", cwd: "/work" },
      },
    },
  });
});

test("buildCheckBody fills defaults for missing fields", () => {
  const body = buildCheckBody({}, TEST_CONFIG, SURFACE_V1, {
    id: "unknown",
    source: "none",
  });

  assert.equal(body.subject.type, "kiro");
  assert.equal(body.subject.id, "unknown");
  assert.equal(body.subject.properties.cwd, "unknown");
  assert.equal(body.subject.properties.surface, "kiro-v1");
  assert.equal(body.subject.properties.session_id_source, "none");
  assert.equal(body.resource.id, "unknown");
  assert.equal(body.resource.properties.tool_name_canonical, "unknown");
  assert.deepEqual(body.resource.properties.tool_input, {});
  assert.equal(body.context.integration, "denied-kiro-hook");
  assert.equal(body.context.payload_fidelity, "none");
});

test("buildCheckBody records the raw tool name and its canonical form", () => {
  const body = buildCheckBody(
    { tool_name: "shell", tool_input: { command: "ls" } },
    TEST_CONFIG,
    SURFACE_CLI_V2,
    { id: "sess-1", source: "session_id" },
  );

  assert.equal(body.resource.id, "shell");
  assert.equal(body.resource.properties.tool_name_canonical, "execute_bash");
  assert.equal(body.subject.properties.surface, "cli-v2");
});

test("buildCheckBody derives a subject id when none is supplied", () => {
  const body = buildCheckBody({ session_id: "sess-1" }, TEST_CONFIG);
  assert.equal(body.subject.id, "sess-1");
  assert.equal(body.subject.properties.session_id_source, "session_id");
});

test("buildCheckBody honors request context flags", () => {
  const body = buildCheckBody(
    { tool_name: "read_file", tool_input: { path: "/a" } },
    { ...TEST_CONFIG, includeToolInput: false, includeHookPayload: false },
    SURFACE_V1,
    { id: "sess-1", source: "session_id" },
  );

  assert.deepEqual(body.resource.properties, { tool_name_canonical: "read_file" });
  assert.equal("hook_payload" in body.context, false);
  // Fidelity is reported from the payload, not from what we chose to forward.
  assert.equal(body.context.payload_fidelity, "full");
});

test("buildCheckBody redacts before truncating so secrets cannot survive in a preview", () => {
  const input = {
    tool_name: "execute_bash",
    tool_input: { command: "deploy", token: "dn_live_supersecret_value" },
  };
  const body = buildCheckBody(
    { ...input },
    { ...TEST_CONFIG, maxContextBytes: 40 },
    SURFACE_V1,
    { id: "sess-1", source: "session_id" },
  );

  assert.equal(body.resource.properties.tool_input.truncated, true);
  assert.equal(
    JSON.stringify(body.resource.properties.tool_input).includes("supersecret"),
    false,
  );
  assert.equal(JSON.stringify(body.context.hook_payload).includes("supersecret"), false);
});

test("buildCheckBody skips redaction when it is disabled", () => {
  const body = buildCheckBody(
    { tool_name: "execute_bash", tool_input: { token: "dn_live_1" } },
    { ...TEST_CONFIG, redaction: { enabled: false, keys: [] } },
    SURFACE_V1,
    { id: "sess-1", source: "session_id" },
  );

  assert.deepEqual(body.resource.properties.tool_input, { token: "dn_live_1" });
});

test("buildCheckBody does not mutate the hook payload it is given", () => {
  const input = { tool_name: "fs_write", tool_input: { path: "/a", secret: "s" } };
  buildCheckBody(input, TEST_CONFIG, SURFACE_V1, { id: "s", source: "session_id" });
  assert.equal(input.tool_input.secret, "s");
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test("appendAuditRecord writes configured sections", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "denied-kiro-audit-"));
  try {
    await appendAuditRecord(
      { tool_input: { command: "ls" } },
      { resource: { id: "execute_bash" } },
      { decision: true },
      {
        ...TEST_CONFIG,
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
      await fs.readFile(path.join(dir, "denied-kiro-hook.jsonl"), "utf-8"),
    );
    assert.deepEqual(Object.keys(record).sort(), ["decision", "hook_payload", "timestamp"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("appendAuditRecord redacts the raw payload it stores", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "denied-kiro-audit-"));
  try {
    await appendAuditRecord(
      { tool_input: { command: "deploy", api_key: "dn_live_secret" } },
      {},
      { decision: true },
      {
        ...TEST_CONFIG,
        audit: {
          enabled: true,
          dir,
          includeRawPayload: true,
          includeMappedRequest: false,
          includeDecision: false,
        },
      },
    );
    const raw = await fs.readFile(path.join(dir, "denied-kiro-hook.jsonl"), "utf-8");
    assert.equal(raw.includes("dn_live_secret"), false);
    assert.equal(raw.includes("[REDACTED]"), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("appendAuditRecord writes nothing when auditing is disabled", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "denied-kiro-audit-"));
  try {
    await appendAuditRecord({}, {}, {}, {
      ...TEST_CONFIG,
      audit: { ...TEST_CONFIG.audit, enabled: false, dir },
    });
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Decision handling
// ---------------------------------------------------------------------------

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
    interpretDecision({ decision: false, context: { reason: "blocked: rm" } }).reason,
    "blocked: rm",
  );
  assert.equal(
    interpretDecision({ decision: true, context: { reason: "ok: read" } }).reason,
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

// ---------------------------------------------------------------------------
// The exit-code invariant — exit 1 blocks in the IDE but only warns in the CLI,
// so any code other than 0 or 2 silently overrides the configured failMode.
// ---------------------------------------------------------------------------

test("resolveExitCode maps an explicit decision regardless of fail mode", () => {
  for (const failMode of ["open", "closed"]) {
    assert.equal(resolveExitCode("allow", failMode), EXIT_ALLOW);
    assert.equal(resolveExitCode("deny", failMode), EXIT_DENY);
  }
});

test("resolveExitCode routes every non-decision outcome through failMode", () => {
  const outcomes = [
    "error",
    "uncaught",
    "unhandled_rejection",
    "watchdog",
    "no_api_key",
    "stdin_unreadable",
  ];
  for (const kind of outcomes) {
    assert.equal(resolveExitCode(kind, "open"), EXIT_ALLOW, kind);
    assert.equal(resolveExitCode(kind, "closed"), EXIT_DENY, kind);
  }
});

test("resolveExitCode yields exactly 0 or 2 for every outcome and fail mode", () => {
  const kinds = [
    "allow",
    "deny",
    "error",
    "uncaught",
    "watchdog",
    "ALLOW",
    "Deny",
    "",
    undefined,
    null,
    0,
    {},
  ];
  const failModes = ["open", "closed", "OPEN", "", "nonsense", undefined, null];

  for (const kind of kinds) {
    for (const failMode of failModes) {
      const code = resolveExitCode(kind, failMode);
      assert.ok(
        code === EXIT_ALLOW || code === EXIT_DENY,
        `resolveExitCode(${String(kind)}, ${String(failMode)}) => ${String(code)}`,
      );
    }
  }
});

test("resolveExitCode treats a mis-cased outcome kind as a fail-safe, not an allow", () => {
  assert.equal(resolveExitCode("ALLOW", "closed"), EXIT_DENY);
  assert.equal(resolveExitCode("Deny", "open"), EXIT_ALLOW);
});
