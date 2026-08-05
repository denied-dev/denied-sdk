// Tests for the Antigravity interceptor.
//
// Two halves, per docs/plans/antigravity-extension-plan.md §8:
//   §8.1 — unit tests over the pure logic (config, mapping, redaction,
//          truncation, transcript extraction, decision shaping).
//   §8.2 — hazard tests H1–H13, which run the interceptor as a *real
//          subprocess* because exit code + stdout is the entire host contract.
//          Antigravity's handling of a broken hook is version-unstable (deny on
//          agy <= 1.1.7, silent allow on 1.1.10), so every one of these
//          scenarios must still end in exit 0 plus exactly one JSON decision.
//   §8.3 — regression guards for the two adversarial review rounds (R1–R13).
//          Every finding below shipped past §8.1/§8.2, so each test is named
//          for the finding it pins rather than for the function it calls.
//
// Run with: node --test (Node 18+, zero dependencies).

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs").promises;
const { mkdtempSync, rmSync } = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { Readable, PassThrough } = require("node:stream");

const {
  WATCHDOG_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  BUDGET_SLACK_MS,
  DEFAULT_STDIN_TIMEOUT_MS,
  DEFAULT_CONFIG_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_AUDIT_TIMEOUT_MS,
  DEFAULT_TAIL_BYTES,
  DEFAULT_REDACT_KEYS,
  MAX_REDACT_STRING_BYTES,
  MAX_REASON_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_STDIN_BYTES,
  MAX_TOOL_NAME_BYTES,
  FAIL_MODES,
  resolveConfigPath,
  loadFileConfig,
  loadRuntimeConfig,
  resolveConfig,
  expandHome,
  resolveTranscriptPath,
  transcriptCandidates,
  truncateJsonValue,
  truncateUtf8,
  truncatePromptString,
  boundedContext,
  redactValue,
  isSensitiveKey,
  redactStringSecrets,
  inferEffect,
  inferShellEffect,
  deriveSurface,
  caseInsensitiveGet,
  parseHookPayload,
  repairTruncatedJson,
  normalizeToolCall,
  workspacePathList,
  buildCheckBody,
  interpretDecision,
  resolveFailSafe,
  buildDecisionOutput,
  extractLastUserPrompt,
  readLastUserPrompt,
  appendAuditRecord,
  readStdin,
  emitDecision,
  hasEmitted,
  resetEmitState,
} = require("./interceptor.js");

// Resolved from an empty environment so the developer's own DENIED_* variables
// (this repo's dev machines export DENIED_URL / DENIED_API_KEY) cannot leak
// into the expected request bodies.
const TEST_CONFIG = resolveConfig({}, {});

const INTERCEPTOR = path.join(__dirname, "interceptor.js");
const VALID_DECISIONS = ["allow", "deny", "force_ask"];

// One temp root for the whole file: config files, fake HOMEs, preload scripts
// and audit directories. Created synchronously so it is available to helpers at
// module scope, and removed on process exit so the suite leaves nothing behind.
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "denied-antigravity-test-"));
process.on("exit", () => rmSync(TMP_ROOT, { recursive: true, force: true }));

let uniqueCounter = 0;
function tmpPath(name) {
  uniqueCounter += 1;
  return path.join(TMP_ROOT, `${uniqueCounter}-${name}`);
}

async function tmpDir(name) {
  const dir = tmpPath(name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value), "utf-8");
  return file;
}

// ---------------------------------------------------------------------------
// Subprocess + stub-PDP harness (§8.2)
// ---------------------------------------------------------------------------

// A deliberately explicit environment. process.env is never inherited: this
// machine exports DENIED_URL / DENIED_API_KEY, and env beats file config, so an
// inherited environment would quietly invalidate every hazard test.
const CHILD_HOME = mkdtempSync(path.join(TMP_ROOT, "home-"));
const MISSING_CONFIG = path.join(CHILD_HOME, "no-such-config.json");

function childEnv(extra = {}) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: CHILD_HOME,
    // Points at a file that does not exist, so a child never picks up the
    // developer's real ~/.denied/config.json unless the test says so.
    DENIED_CONFIG: MISSING_CONFIG,
    ...extra,
  };
}

function runInterceptor({
  env = {},
  stdin = "",
  keepStdinOpen = false,
  preload,
  args = [],
  // Called with the spawned child before stdin is written, so a test can signal
  // it (§8.3 R3) without racing the promise this returns.
  onChild,
} = {}) {
  return new Promise((resolve, reject) => {
    const argv = [];
    if (preload) {
      argv.push("-r", preload);
    }
    argv.push(INTERCEPTOR, ...args);

    const started = Date.now();
    const child = spawn(process.execPath, argv, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", () => {
      /* the child may exit before the payload is fully written */
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr, durationMs: Date.now() - started });
    });

    if (typeof onChild === "function") {
      onChild(child);
    }

    if (keepStdinOpen) {
      if (stdin) {
        child.stdin.write(stdin);
      }
    } else {
      child.stdin.end(stdin);
    }
  });
}

// The contract in one assertion: exit 0, and stdout is exactly one JSON object
// carrying a decision from the documented enum. JSON.parse rejects a second
// object or any stray log line, which is invariant 3.
function assertDecision(result, context = "") {
  const detail = `${context}\n  exit=${result.code} signal=${result.signal}\n  stdout=${JSON.stringify(result.stdout)}\n  stderr=${result.stderr}`;
  assert.equal(result.code, 0, `expected exit 0.${detail}`);
  assert.notEqual(result.stdout.trim(), "", `expected a decision on stdout.${detail}`);

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    assert.fail(`stdout was not exactly one JSON object (${err.message}).${detail}`);
  }
  assert.ok(
    parsed && typeof parsed === "object" && !Array.isArray(parsed),
    `decision payload must be an object.${detail}`,
  );
  assert.ok(
    VALID_DECISIONS.includes(parsed.decision),
    `decision must be one of ${VALID_DECISIONS.join("|")}.${detail}`,
  );
  // `{}` is not an allow on this platform — it denies — and `block` is not a
  // recognized value at all (§0.5 item 4).
  assert.notEqual(parsed.decision, "block", `"block" is never a valid decision.${detail}`);
  return parsed;
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// An in-process stub PDP on an ephemeral port. Sockets are tracked explicitly
// so a never-responding server can still be torn down on Node 18.
function startStubServer(handler) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      requests.push({ url: req.url, headers: req.headers, raw, json: safeJson(raw) });
      handler(req, res, raw);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.unref();

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            sockets.clear();
            server.close(() => done());
          }),
      });
    });
  });
}

function jsonServer(body, status = 200) {
  return startStubServer((req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
}

const ALLOW_BODY = { decision: true, context: { reason: "ok" } };

async function withServer(factory, fn) {
  const server = await factory();
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

// A port nothing is listening on: bind an ephemeral port, then release it.
async function closedPortUrl() {
  const server = await jsonServer(ALLOW_BODY);
  const { url } = server;
  await server.close();
  return url;
}

async function writePreload(name, source) {
  const file = tmpPath(name);
  await fs.writeFile(file, source, "utf-8");
  return file;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The M0.4 CLI capture (docs/spikes/step-0/RESULTS.md) — absolute transcript
// path, PascalCase args, modelName, conversationId.
function capturedPayload(overrides = {}) {
  return {
    artifactDirectoryPath:
      "/Users/dev/.gemini/antigravity-cli/brain/435c93dd-d1ea-4fac-988d-c8e1eb9f5c76",
    conversationId: "435c93dd-d1ea-4fac-988d-c8e1eb9f5c76",
    stepIdx: 19,
    toolCall: {
      name: "run_command",
      args: { CommandLine: "npm test", Cwd: "/w/p", WaitMsBeforeAsync: 1000 },
    },
    transcriptPath:
      "/Users/dev/.gemini/antigravity-cli/brain/435c93dd-d1ea-4fac-988d-c8e1eb9f5c76/.system_generated/logs/transcript.jsonl",
    workspacePaths: ["/Users/dev/dev/proj"],
    modelName: "gemini-3.6-flash-high",
    ...overrides,
  };
}

// Transcript records, byte-shaped like the pinned schema in
// docs/spikes/step-0/antigravity-transcript-schema.md.
function userInputLine(prompt, extras = "") {
  return JSON.stringify({
    step_index: 14,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: "2026-08-04T23:42:14Z",
    content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-08-05T01:42:14+02:00.\n</ADDITIONAL_METADATA>${extras}`,
  });
}

const CHECKPOINT_LINE = JSON.stringify({
  step_index: 16,
  source: "SYSTEM",
  type: "CHECKPOINT",
  status: "DONE",
  created_at: "2026-08-04T23:43:00Z",
  // CHECKPOINT records restate prompt text in prose; a naive substring scan
  // would match this instead of the real USER_INPUT record.
  content: "# User Requests\n1. Run a `pwd` command using the `run_command` tool.",
});

const PLANNER_LINE = JSON.stringify({
  step_index: 15,
  source: "MODEL",
  type: "PLANNER_RESPONSE",
  status: "DONE",
  created_at: "2026-08-04T23:42:14Z",
  tool_calls: [{ name: "run_command", args: { CommandLine: "whoami", Cwd: "/w" } }],
});

// ===========================================================================
// §8.1 — Configuration
// ===========================================================================

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
  assert.deepEqual(await loadFileConfig(tmpPath("missing.json")), {});
});

test("loadFileConfig parses a valid JSON file", async () => {
  const file = await writeJson(tmpPath("cfg.json"), {
    apiKey: "dn_file",
    url: "https://f",
  });
  assert.deepEqual(await loadFileConfig(file), { apiKey: "dn_file", url: "https://f" });
});

test("loadFileConfig warns and returns {} on malformed JSON", async () => {
  const file = tmpPath("bad.json");
  await fs.writeFile(file, "{ not json", "utf-8");
  let warned = "";
  assert.deepEqual(await loadFileConfig(file, (m) => (warned = m)), {});
  assert.match(warned, /malformed config file/);
});

test("loadFileConfig warns and returns {} on valid JSON that is not an object", async () => {
  const array = await writeJson(tmpPath("array.json"), [1, 2]);
  const scalar = tmpPath("scalar.json");
  await fs.writeFile(scalar, '"hello"', "utf-8");

  // Wrong-shape JSON discards apiKey and failMode wholesale, so it has to be
  // as loud as a parse failure rather than silently resolving to defaults.
  let arrayWarning = "";
  assert.deepEqual(await loadFileConfig(array, (m) => (arrayWarning = m)), {});
  assert.match(arrayWarning, /expected a JSON object, found array/);

  let scalarWarning = "";
  assert.deepEqual(await loadFileConfig(scalar, (m) => (scalarWarning = m)), {});
  assert.match(scalarWarning, /expected a JSON object, found string/);
});

test("resolveConfig falls back to defaults with no env or file", () => {
  assert.deepEqual(resolveConfig({}, {}, () => {}, "/home/dev"), {
    url: "https://api.denied.dev",
    apiKey: "",
    failMode: "open",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    surface: "unknown",
    includeToolInput: true,
    includeHookPayload: true,
    includeLastUserPrompt: true,
    maxContextBytes: 20000,
    redaction: {
      enabled: true,
      keys: ["api_key", "apikey", "authorization", "password", "secret", "token"],
    },
    audit: {
      enabled: false,
      dir: path.join("/home/dev", ".denied", "audit"),
      includeRawPayload: true,
      includeMappedRequest: true,
      includeDecision: true,
    },
  });
});

test("resolveConfig reads values from the file when env is absent", () => {
  const cfg = resolveConfig(
    {},
    { apiKey: "dn_file", url: "https://file", failMode: "CLOSED", timeoutMs: 1500 },
  );
  assert.equal(cfg.apiKey, "dn_file");
  assert.equal(cfg.url, "https://file");
  assert.equal(cfg.failMode, "closed");
  assert.equal(cfg.timeoutMs, 1500);
});

test("resolveConfig lets environment variables override the file", () => {
  const cfg = resolveConfig(
    {
      DENIED_API_KEY: "dn_env",
      DENIED_URL: "https://env",
      DENIED_FAIL_MODE: "closed",
      DENIED_TIMEOUT_MS: "1000",
    },
    { apiKey: "dn_file", url: "https://file", failMode: "open", timeoutMs: 4000 },
  );
  assert.equal(cfg.url, "https://env");
  assert.equal(cfg.apiKey, "dn_env");
  assert.equal(cfg.failMode, "closed");
  assert.equal(cfg.timeoutMs, 1000);
});

test("resolveConfig ignores a non-numeric DENIED_TIMEOUT_MS and uses the file value", () => {
  assert.equal(resolveConfig({ DENIED_TIMEOUT_MS: "abc" }, { timeoutMs: 3000 }).timeoutMs, 3000);
});

test("resolveConfig rejects a zero or negative timeout at every tier", () => {
  // A non-positive timeout would abort every PDP call before it completes —
  // a gate that silently never enforces.
  assert.equal(resolveConfig({ DENIED_TIMEOUT_MS: "0" }, {}).timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(resolveConfig({ DENIED_TIMEOUT_MS: "-5" }, { timeoutMs: 3000 }).timeoutMs, 3000);
  assert.equal(resolveConfig({}, { timeoutMs: 0 }).timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(resolveConfig({}, { timeoutMs: -1 }).timeoutMs, DEFAULT_TIMEOUT_MS);
});

test("resolveConfig clamps a timeout that would outlive the watchdog and warns", () => {
  // Past MAX_TIMEOUT_MS the fetch could outlive the watchdog, converting a slow
  // PDP into a watchdog fail-safe instead of the configured outcome.
  const warnings = [];
  const cfg = resolveConfig(
    { DENIED_TIMEOUT_MS: "20000" },
    {},
    (m) => warnings.push(m),
  );
  assert.equal(cfg.timeoutMs, MAX_TIMEOUT_MS);
  assert.deepEqual(warnings, [
    `timeoutMs 20000ms exceeds the ${WATCHDOG_MS}ms watchdog budget; clamping to ${MAX_TIMEOUT_MS}ms.`,
  ]);

  const fileWarnings = [];
  assert.equal(
    resolveConfig({}, { timeoutMs: 9000 }, (m) => fileWarnings.push(m)).timeoutMs,
    MAX_TIMEOUT_MS,
  );
  assert.equal(fileWarnings.length, 1);
});

test("the timeout budget nests strictly inside the watchdog", () => {
  // Maintainer rule (§5.5): stdin + fetch + transcript < watchdog < hook timeout.
  assert.equal(
    MAX_TIMEOUT_MS,
    WATCHDOG_MS - DEFAULT_STDIN_TIMEOUT_MS - DEFAULT_READ_TIMEOUT_MS,
  );
  assert.ok(DEFAULT_TIMEOUT_MS <= MAX_TIMEOUT_MS);
  assert.ok(
    DEFAULT_STDIN_TIMEOUT_MS + DEFAULT_TIMEOUT_MS + DEFAULT_READ_TIMEOUT_MS <= WATCHDOG_MS,
  );
  assert.equal(WATCHDOG_MS < 10_000, true); // below the hooks.json `timeout: 10`
});

test("resolveConfig does not clamp a timeout at the budget boundary", () => {
  const warnings = [];
  assert.equal(
    resolveConfig({}, { timeoutMs: MAX_TIMEOUT_MS }, (m) => warnings.push(m)).timeoutMs,
    MAX_TIMEOUT_MS,
  );
  assert.deepEqual(warnings, []);
});

test("resolveConfig accepts every documented failMode", () => {
  assert.deepEqual(FAIL_MODES, ["open", "closed", "ask"]);
  for (const mode of FAIL_MODES) {
    assert.equal(resolveConfig({ DENIED_FAIL_MODE: mode.toUpperCase() }, {}).failMode, mode);
    assert.equal(resolveConfig({}, { failMode: ` ${mode} ` }).failMode, mode);
  }
});

test("resolveConfig warns and falls back on an unknown failMode", () => {
  const warnings = [];
  const cfg = resolveConfig({ DENIED_FAIL_MODE: "maybe" }, {}, (m) => warnings.push(m));
  assert.equal(cfg.failMode, "open");
  assert.deepEqual(warnings, ['Unknown failMode "maybe"; falling back to "open".']);
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
        includeLastUserPrompt: false,
        maxContextBytes: 128,
      },
    },
  );
  assert.equal(cfg.includeToolInput, false);
  assert.equal(cfg.includeHookPayload, false);
  assert.equal(cfg.includeLastUserPrompt, false);
  assert.equal(cfg.maxContextBytes, 128);
});

test("resolveConfig ignores a non-positive maxContextBytes", () => {
  assert.equal(resolveConfig({}, { request: { maxContextBytes: 0 } }).maxContextBytes, 20000);
  assert.equal(resolveConfig({}, { request: { maxContextBytes: -5 } }).maxContextBytes, 20000);
});

test("resolveConfig takes the surface fallback from the file only", () => {
  assert.equal(resolveConfig({}, { surface: "ide" }).surface, "ide");
  assert.equal(resolveConfig({}, { surface: 42 }).surface, "unknown");
  assert.equal(resolveConfig({}, {}).surface, "unknown");
});

test("resolveConfig lets the file disable redaction and replace the key list", () => {
  assert.equal(resolveConfig({}, { redaction: { enabled: false } }).redaction.enabled, false);
  assert.deepEqual(
    resolveConfig({}, { redaction: { keys: ["ssn", 7, ""] } }).redaction.keys,
    ["ssn"],
  );
});

test("resolveConfig falls back to the default keys when the file list is unusable", () => {
  assert.deepEqual(resolveConfig({}, { redaction: { keys: "token" } }).redaction.keys, [
    ...DEFAULT_REDACT_KEYS,
  ]);
  assert.deepEqual(resolveConfig({}, { redaction: { keys: [] } }).redaction.keys, [
    ...DEFAULT_REDACT_KEYS,
  ]);
});

test("resolveConfig reads the audit block and expands a ~ audit dir", () => {
  const cfg = resolveConfig(
    {},
    { audit: { enabled: true, dir: "~/logs", includeRawPayload: false } },
    () => {},
    "/home/dev",
  );
  assert.equal(cfg.audit.enabled, true);
  assert.equal(cfg.audit.dir, path.join("/home/dev", "logs"));
  assert.equal(cfg.audit.includeRawPayload, false);
  assert.equal(cfg.audit.includeMappedRequest, true);
});

test("resolveConfig survives a non-object file config", () => {
  for (const value of [null, undefined, [1, 2], "nope", 7]) {
    const cfg = resolveConfig({}, value, () => {}, "/home/dev");
    assert.equal(cfg.failMode, "open");
    assert.equal(cfg.url, "https://api.denied.dev");
  }
});

test("loadRuntimeConfig resolves config from the async file loader", async () => {
  const file = await writeJson(tmpPath("runtime.json"), {
    apiKey: "dn_file",
    failMode: "ask",
  });
  const cfg = await loadRuntimeConfig({ DENIED_CONFIG: file }, "/home/dev", () => {});
  assert.equal(cfg.apiKey, "dn_file");
  assert.equal(cfg.failMode, "ask");
  assert.equal(cfg.audit.dir, path.join("/home/dev", ".denied", "audit"));
});

test("expandHome resolves ~ and leaves everything else alone", () => {
  assert.equal(expandHome("~", "/home/dev"), "/home/dev");
  assert.equal(expandHome("~/.gemini/x", "/home/dev"), path.join("/home/dev", ".gemini/x"));
  assert.equal(expandHome("~notme/x", "/home/dev"), "~notme/x");
  assert.equal(expandHome("/abs/x", "/home/dev"), "/abs/x");
  assert.equal(expandHome("rel/x", "/home/dev"), "rel/x");
  assert.equal(expandHome(42, "/home/dev"), 42);
  assert.equal(expandHome(undefined, "/home/dev"), undefined);
});

// ===========================================================================
// §8.1 — Payload handling
// ===========================================================================

test("parseHookPayload resolves an absent or unusable payload to {}", () => {
  // A garbage payload is not a reason to stop asking the PDP.
  assert.deepEqual(parseHookPayload(""), {});
  assert.deepEqual(parseHookPayload("   \n"), {});
  assert.deepEqual(parseHookPayload("not json"), {});
  assert.deepEqual(parseHookPayload("[1,2]"), {});
  assert.deepEqual(parseHookPayload("null"), {});
  assert.deepEqual(parseHookPayload("42"), {});
  assert.deepEqual(parseHookPayload(undefined), {});
});

test("parseHookPayload parses a well-formed hook payload", () => {
  assert.deepEqual(parseHookPayload('{"toolCall":{"name":"run_command"}}'), {
    toolCall: { name: "run_command" },
  });
});

test("caseInsensitiveGet finds PascalCase Antigravity arg keys under any casing", () => {
  const args = { CommandLine: "npm test", cwd: "/w", WaitMsBeforeAsync: 1000 };
  assert.equal(caseInsensitiveGet(args, "CommandLine"), "npm test");
  assert.equal(caseInsensitiveGet(args, "commandline"), "npm test");
  assert.equal(caseInsensitiveGet(args, "COMMANDLINE"), "npm test");
  assert.equal(caseInsensitiveGet(args, "Cwd"), "/w");
  assert.equal(caseInsensitiveGet(args, "missing"), undefined);
});

test("caseInsensitiveGet never resolves inherited properties", () => {
  assert.equal(caseInsensitiveGet({}, "constructor"), undefined);
  assert.equal(caseInsensitiveGet({}, "toString"), undefined);
  assert.equal(caseInsensitiveGet({}, "__proto__"), undefined);
});

test("caseInsensitiveGet tolerates a non-object source", () => {
  for (const source of [null, undefined, "str", 7, [1, 2]]) {
    assert.equal(caseInsensitiveGet(source, "CommandLine"), undefined);
  }
});

test("normalizeToolCall defaults an absent or null toolCall to unknown", () => {
  // toolCall has been observed null (antigravity-cli#395).
  assert.deepEqual(normalizeToolCall({ toolCall: null }), { name: "unknown", args: {} });
  assert.deepEqual(normalizeToolCall({}), { name: "unknown", args: {} });
  assert.deepEqual(normalizeToolCall(null), { name: "unknown", args: {} });
  assert.deepEqual(normalizeToolCall({ toolCall: { name: 42 } }), {
    name: "unknown",
    args: {},
  });
  assert.deepEqual(normalizeToolCall({ toolCall: { name: "" } }), {
    name: "unknown",
    args: {},
  });
});

test("normalizeToolCall reads the legacy arguments key", () => {
  assert.deepEqual(
    normalizeToolCall({ toolCall: { name: "run_command", arguments: { CommandLine: "ls" } } }),
    { name: "run_command", args: { CommandLine: "ls" } },
  );
  // `args` wins when both are present.
  assert.deepEqual(
    normalizeToolCall({
      toolCall: { name: "run_command", args: { CommandLine: "a" }, arguments: { CommandLine: "b" } },
    }),
    { name: "run_command", args: { CommandLine: "a" } },
  );
});

test("normalizeToolCall rejects non-object args", () => {
  assert.deepEqual(normalizeToolCall({ toolCall: { name: "x", args: [1, 2] } }).args, {});
  assert.deepEqual(normalizeToolCall({ toolCall: { name: "x", args: "cmd" } }).args, {});
});

test("workspacePathList keeps only non-empty strings", () => {
  assert.deepEqual(workspacePathList({ workspacePaths: ["/a", "", 7, null, "/b"] }), ["/a", "/b"]);
  assert.deepEqual(workspacePathList({ workspacePaths: "not-an-array" }), []);
  assert.deepEqual(workspacePathList({}), []);
  assert.deepEqual(workspacePathList(null), []);
});

// ===========================================================================
// §8.1 — Surface derivation
// ===========================================================================

test("deriveSurface reads the profile directory out of the payload paths", () => {
  assert.equal(
    deriveSurface({ artifactDirectoryPath: "/h/.gemini/antigravity-cli/brain/x" }),
    "cli",
  );
  assert.equal(
    deriveSurface({ artifactDirectoryPath: "/h/.gemini/antigravity-ide/brain/x" }),
    "ide",
  );
  assert.equal(
    deriveSurface({ artifactDirectoryPath: "/h/.gemini/antigravity/brain/x" }),
    "app",
  );
});

test("deriveSurface falls back to transcriptPath when there is no artifact dir", () => {
  assert.equal(
    deriveSurface({ transcriptPath: "/h/.gemini/antigravity-ide/brain/x/t.jsonl" }),
    "ide",
  );
  assert.equal(
    deriveSurface({ artifactDirectoryPath: 42, transcriptPath: "/h/.gemini/antigravity/x" }),
    "app",
  );
});

test("deriveSurface prefers the artifact dir over the transcript path", () => {
  assert.equal(
    deriveSurface({
      artifactDirectoryPath: "/h/.gemini/antigravity-cli/brain/x",
      transcriptPath: "/h/.gemini/antigravity-ide/brain/x/t.jsonl",
    }),
    "cli",
  );
});

test("deriveSurface checks the -cli and -ide markers before the bare one", () => {
  // `/antigravity/` is a prefix-shaped decoy: a workspace under a directory
  // literally named "antigravity" must not out-vote the profile directory.
  assert.equal(
    deriveSurface({ artifactDirectoryPath: "/h/antigravity/.gemini/antigravity-cli/brain/x" }),
    "cli",
  );
  assert.equal(
    deriveSurface({ artifactDirectoryPath: "/h/antigravity/.gemini/antigravity-ide/brain/x" }),
    "ide",
  );
});

test("deriveSurface normalizes Windows-style backslash paths", () => {
  assert.equal(
    deriveSurface({ artifactDirectoryPath: "C:\\Users\\me\\.gemini\\antigravity-cli\\brain\\x" }),
    "cli",
  );
  assert.equal(
    deriveSurface({ transcriptPath: "C:\\Users\\me\\.gemini\\antigravity-ide\\brain\\x\\t.jsonl" }),
    "ide",
  );
});

test("deriveSurface uses the configured fallback then unknown", () => {
  assert.equal(deriveSurface({}, "cli"), "cli");
  assert.equal(deriveSurface({ artifactDirectoryPath: "/tmp/elsewhere" }, "ide"), "ide");
  assert.equal(deriveSurface({}), "unknown");
  assert.equal(deriveSurface(null), "unknown");
  assert.equal(deriveSurface({}, ""), "unknown");
  assert.equal(deriveSurface({}, 42), "unknown");
});

// ===========================================================================
// §8.1 — Effect inference
// ===========================================================================

test("inferShellEffect classifies common command shapes", () => {
  assert.equal(inferShellEffect("rm -rf /tmp/x"), "delete");
  assert.equal(inferShellEffect("rmdir build"), "delete");
  assert.equal(inferShellEffect("sed -i s/a/b/ f"), "update");
  assert.equal(inferShellEffect("chmod 600 secrets"), "update");
  assert.equal(inferShellEffect("echo hi > out.txt"), "create");
  assert.equal(inferShellEffect("cat a >> b"), "create");
  assert.equal(inferShellEffect("cp a b"), "create");
  assert.equal(inferShellEffect("mkdir -p x"), "create");
  assert.equal(inferShellEffect("tee out"), "create");
  assert.equal(inferShellEffect("ls -la"), "read");
  assert.equal(inferShellEffect("grep -r foo ."), "read");
  assert.equal(inferShellEffect("npm test"), "execute");
});

test("inferShellEffect defaults to execute for an absent command", () => {
  assert.equal(inferShellEffect(undefined), "execute");
  assert.equal(inferShellEffect(""), "execute");
  assert.equal(inferShellEffect(42), "execute");
});

test("inferEffect reads run_command's CommandLine under any casing", () => {
  assert.equal(inferEffect("run_command", { CommandLine: "rm -rf /tmp/x" }), "delete");
  assert.equal(inferEffect("run_command", { commandline: "ls -la" }), "read");
  assert.equal(inferEffect("RUN_COMMAND", { CommandLine: "echo hi > f" }), "create");
  // No command line at all: the most restrictive sensible default.
  assert.equal(inferEffect("run_command", {}), "execute");
});

test("inferEffect maps the published built-in tool list", () => {
  const table = [
    ["view_file", "read"],
    ["list_dir", "read"],
    ["find_by_name", "read"],
    ["grep_search", "read"],
    ["search_web", "read"],
    ["read_url_content", "read"],
    ["write_to_file", "create"],
    ["generate_image", "create"],
    ["replace_file_content", "update"],
    ["multi_replace_file_content", "update"],
  ];
  for (const [name, effect] of table) {
    assert.equal(inferEffect(name, {}), effect, name);
  }
});

test("inferEffect falls through to the generic name patterns", () => {
  assert.equal(inferEffect("delete_thing", {}), "delete");
  assert.equal(inferEffect("update_record", {}), "update");
  assert.equal(inferEffect("create_issue", {}), "create");
  assert.equal(inferEffect("list_issues", {}), "read");
});

test("inferEffect defaults an unknown or MCP tool name to execute", () => {
  // Unknown names reach the PDP untouched; the effect is the safe default.
  assert.equal(inferEffect("@acme/frobnicate", {}), "execute");
  assert.equal(inferEffect("some_future_tool", {}), "execute");
  assert.equal(inferEffect("invoke_subagent", {}), "execute");
  assert.equal(inferEffect("", {}), "execute");
  assert.equal(inferEffect(undefined, undefined), "execute");
});

// ===========================================================================
// §8.1 — Redaction
// ===========================================================================

test("isSensitiveKey matches on the normalized key", () => {
  for (const key of ["api_key", "apiKey", "X-API-Key", "AUTHORIZATION", "password", "secret", "token", "access_token"]) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  for (const key of ["path", "CommandLine", "Cwd", "name"]) {
    assert.equal(isSensitiveKey(key), false, key);
  }
  assert.equal(isSensitiveKey("ssn", ["ssn"]), true);
  assert.equal(isSensitiveKey("token", ["ssn"]), false);
});

test("redactValue replaces sensitive values including nested ones", () => {
  const input = {
    CommandLine: "deploy",
    token: "dn_live_123",
    nested: { env: [{ name: "HOME", secret: "s" }, { password: "p" }] },
  };
  assert.deepEqual(redactValue(input), {
    CommandLine: "deploy",
    token: "[REDACTED]",
    nested: { env: [{ name: "HOME", secret: "[REDACTED]" }, { password: "[REDACTED]" }] },
  });
});

test("redactValue is non-destructive", () => {
  const input = { a: { b: [1, 2, "three"] }, n: null, t: true };
  const output = redactValue(input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.notEqual(output.a, input.a);
});

test("redactValue rewrites secrets embedded in free-form strings", () => {
  // Key-based redaction alone would leave a `run_command` command line intact.
  assert.equal(
    redactValue({ CommandLine: 'curl -H "authorization: bearer abc123" https://x' }).CommandLine,
    'curl -H "authorization: bearer [REDACTED]" https://x',
  );
  assert.equal(
    redactStringSecrets("deploy --api-key=sk_live_123 --other"),
    "deploy --api-key=[REDACTED] --other",
  );
  assert.equal(redactStringSecrets("export TOKEN=sekrit && run"), "export TOKEN=[REDACTED] && run");
  assert.equal(redactStringSecrets("aws --token sk_1 --secret s2"), "aws --token [REDACTED] --secret [REDACTED]");
  assert.equal(redactStringSecrets("npm test"), "npm test");
  assert.equal(redactStringSecrets(7), 7);
});

test("redactValue terminates on cycles without redacting repeated siblings", () => {
  const cycle = { name: "root" };
  cycle.self = cycle;
  assert.deepEqual(redactValue(cycle), { name: "root", self: "[Circular]" });

  const shared = { token: "t" };
  assert.deepEqual(redactValue({ first: shared, second: shared }), {
    first: { token: "[REDACTED]" },
    second: { token: "[REDACTED]" },
  });
});

test("redactValue bounds recursion depth instead of overflowing the stack", () => {
  // A stack overflow here would fire before main()'s try/catch and skip the
  // PDP call entirely, degrading every deep payload to failMode.
  let deep = { leaf: true };
  for (let i = 0; i < 5_000; i += 1) {
    deep = { nested: deep };
  }
  assert.equal(JSON.stringify(redactValue(deep)).includes("[MaxDepth]"), true);
});

test("redactValue preserves a literal __proto__ key as plain data", () => {
  const input = JSON.parse('{"__proto__": {"a": 1}, "b": 2}');
  assert.equal(JSON.stringify(redactValue(input)), '{"__proto__":{"a":1},"b":2}');
  assert.equal({}.a, undefined);
});

test("redactValue honors a custom key list and passes primitives through", () => {
  assert.deepEqual(redactValue({ ssn: "1", token: "t" }, ["ssn"]), {
    ssn: "[REDACTED]",
    token: "t",
  });
  assert.equal(redactValue(7), 7);
  assert.equal(redactValue(null), null);
});

// ===========================================================================
// §8.1 — Truncation
// ===========================================================================

test("truncateJsonValue returns the value unchanged at the byte boundary", () => {
  const value = { a: "bc" };
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf-8");
  assert.deepEqual(truncateJsonValue(value, bytes), value);
  assert.equal(truncateJsonValue(value, bytes - 1).truncated, true);
});

test("truncateJsonValue returns a Hermes-style preview for oversized values", () => {
  const value = truncateJsonValue({ CommandLine: "x".repeat(50) }, 20);
  assert.equal(value.truncated, true);
  assert.equal(value.max_bytes, 20);
  assert.equal(typeof value.original_bytes, "number");
  assert.equal(typeof value.preview, "string");
  assert.ok(Buffer.byteLength(value.preview, "utf-8") <= 20);
});

test("truncateJsonValue caps previews by UTF-8 byte length without splitting a character", () => {
  const value = truncateJsonValue({ CommandLine: "😀".repeat(20) }, 15);
  assert.equal(value.truncated, true);
  assert.ok(Buffer.byteLength(value.preview, "utf-8") <= value.max_bytes);
  assert.equal(value.preview.includes("\uFFFD"), false);
});

test("truncateJsonValue stringifies a value JSON cannot serialize", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const value = truncateJsonValue(cyclic, 20000);
  assert.equal(typeof value, "string");
  assert.match(value, /object/);
});

test("truncateUtf8 never splits a multibyte character", () => {
  const emoji = "😀😀😀"; // 4 bytes each
  assert.equal(truncateUtf8(emoji, 12), emoji);
  assert.equal(truncateUtf8(emoji, 11), "😀😀");
  assert.equal(truncateUtf8(emoji, 5), "😀");
  assert.equal(truncateUtf8(emoji, 3), "");
  assert.equal(truncateUtf8(emoji, 0), "");
  assert.equal(truncateUtf8("héllo", 2), "h");
  for (let max = 0; max <= 14; max += 1) {
    const out = truncateUtf8(emoji, max);
    assert.equal(out.includes("\uFFFD"), false, `max=${max}`);
    assert.ok(Buffer.byteLength(out, "utf-8") <= Math.max(0, max), `max=${max}`);
  }
});

test("truncatePromptString keeps the prompt a string and marks the cut inline", () => {
  const prompt = "a".repeat(300);
  const out = truncatePromptString(prompt, 120);
  assert.equal(typeof out, "string");
  assert.match(out, / … \[truncated 300 bytes\]$/);
  assert.ok(Buffer.byteLength(out, "utf-8") <= 120);
  assert.ok(out.startsWith("aaaa"));
});

test("truncatePromptString returns short prompts verbatim", () => {
  assert.equal(truncatePromptString("run whoami", 20000), "run whoami");
  assert.equal(truncatePromptString("", 20000), "");
});

test("boundedContext redacts before truncating", () => {
  // The ordering is the point: a secret must not survive inside a preview.
  const value = {
    token: "dn_live_supersecret_value",
    CommandLine: `curl -H "authorization: bearer SUPERSECRET" ${"x".repeat(500)}`,
  };
  const bounded = boundedContext(value, { ...TEST_CONFIG, maxContextBytes: 120 });
  const serialized = JSON.stringify(bounded);
  assert.equal(bounded.truncated, true);
  assert.equal(serialized.includes("supersecret"), false);
  assert.equal(serialized.includes("SUPERSECRET"), false);
  assert.equal(serialized.includes("[REDACTED]"), true);
});

test("boundedContext skips redaction when it is disabled", () => {
  const bounded = boundedContext(
    { token: "dn_live_1" },
    { ...TEST_CONFIG, redaction: { enabled: false, keys: [] } },
  );
  assert.deepEqual(bounded, { token: "dn_live_1" });
});

// ===========================================================================
// §8.1 — AuthZEN mapping
// ===========================================================================

test("buildCheckBody maps the captured PreToolUse payload to an AuthZEN request", () => {
  const body = buildCheckBody(capturedPayload(), TEST_CONFIG);

  assert.deepEqual(body, {
    subject: {
      type: "antigravity",
      id: "435c93dd-d1ea-4fac-988d-c8e1eb9f5c76",
      properties: {
        surface: "cli",
        workspace_paths: ["/Users/dev/dev/proj"],
        cwd: "/w/p",
        step_idx: 19,
        model_name: "gemini-3.6-flash-high",
      },
    },
    action: {
      name: "execute",
      properties: { effect: "execute", tool_name: "run_command" },
    },
    resource: {
      type: "tool",
      id: "run_command",
      properties: {
        tool_input: { CommandLine: "npm test", Cwd: "/w/p", WaitMsBeforeAsync: 1000 },
      },
    },
    context: {
      integration: "denied-antigravity-hook",
      hook_event_name: "PreToolUse",
      authz_direction: "agent-to-world",
      artifact_directory_path:
        "/Users/dev/.gemini/antigravity-cli/brain/435c93dd-d1ea-4fac-988d-c8e1eb9f5c76",
      hook_payload: capturedPayload(),
    },
  });
});

test("buildCheckBody survives toolCall: null and a wholly empty payload", () => {
  // antigravity-cli#395 — never throw, never stop asking the PDP.
  for (const input of [{ toolCall: null }, {}, null, undefined]) {
    const body = buildCheckBody(input, TEST_CONFIG);
    assert.equal(body.resource.id, "unknown");
    assert.equal(body.resource.type, "tool");
    assert.deepEqual(body.resource.properties.tool_input, {});
    assert.equal(body.subject.id, "unknown");
    assert.equal(body.subject.properties.cwd, "unknown");
    assert.equal(body.subject.properties.model_name, "unknown");
    assert.equal(body.subject.properties.step_idx, null);
    assert.deepEqual(body.subject.properties.workspace_paths, []);
    assert.equal(body.subject.properties.surface, "unknown");
    assert.equal(body.action.name, "execute");
    assert.equal(body.action.properties.effect, "execute");
    assert.equal(body.action.properties.tool_name, "unknown");
    assert.equal(body.context.integration, "denied-antigravity-hook");
    assert.equal(body.context.hook_event_name, "PreToolUse");
    assert.equal(body.context.artifact_directory_path, null);
  }
});

test("buildCheckBody reads the legacy arguments key", () => {
  const body = buildCheckBody(
    { toolCall: { name: "run_command", arguments: { CommandLine: "ls -la" } } },
    TEST_CONFIG,
  );
  assert.deepEqual(body.resource.properties.tool_input, { CommandLine: "ls -la" });
  assert.equal(body.action.properties.effect, "read");
});

test("buildCheckBody derives cwd from args under any casing, then workspacePaths", () => {
  assert.equal(
    buildCheckBody(
      { toolCall: { name: "run_command", args: { cwd: "/from/args" } }, workspacePaths: ["/ws"] },
      TEST_CONFIG,
    ).subject.properties.cwd,
    "/from/args",
  );
  assert.equal(
    buildCheckBody({ workspacePaths: ["/ws", "/other"] }, TEST_CONFIG).subject.properties.cwd,
    "/ws",
  );
  assert.equal(buildCheckBody({}, TEST_CONFIG).subject.properties.cwd, "unknown");
});

test("buildCheckBody keeps stepIdx 0 and rejects a non-numeric one", () => {
  assert.equal(buildCheckBody({ stepIdx: 0 }, TEST_CONFIG).subject.properties.step_idx, 0);
  assert.equal(buildCheckBody({ stepIdx: "4" }, TEST_CONFIG).subject.properties.step_idx, null);
});

test("buildCheckBody treats a blank conversationId as unknown", () => {
  assert.equal(buildCheckBody({ conversationId: "" }, TEST_CONFIG).subject.id, "unknown");
  assert.equal(buildCheckBody({ conversationId: 42 }, TEST_CONFIG).subject.id, "unknown");
  // A subagent runs under its own conversationId and is therefore its own
  // subject by construction (§5.3, M0.5).
  assert.equal(buildCheckBody({ conversationId: "sub-1" }, TEST_CONFIG).subject.id, "sub-1");
});

test("buildCheckBody prefers an explicit surface option over derivation", () => {
  const body = buildCheckBody(capturedPayload(), TEST_CONFIG, { surface: "ide" });
  assert.equal(body.subject.properties.surface, "ide");
});

test("buildCheckBody falls back to the configured surface", () => {
  const body = buildCheckBody({}, { ...TEST_CONFIG, surface: "app" });
  assert.equal(body.subject.properties.surface, "app");
});

test("buildCheckBody honors the request context flags", () => {
  const body = buildCheckBody(
    capturedPayload(),
    { ...TEST_CONFIG, includeToolInput: false, includeHookPayload: false },
  );
  assert.deepEqual(body.resource.properties, {});
  assert.equal("hook_payload" in body.context, false);
  // The tool name still reaches the PDP even with the input withheld.
  assert.equal(body.resource.id, "run_command");
});

test("buildCheckBody attaches a redacted, truncated last user prompt", () => {
  const body = buildCheckBody({}, TEST_CONFIG, {
    lastUserPrompt: "deploy with --token sk_live_secret please",
  });
  assert.equal(body.context.last_user_prompt, "deploy with --token [REDACTED] please");

  const long = buildCheckBody({}, { ...TEST_CONFIG, maxContextBytes: 60 }, {
    lastUserPrompt: "z".repeat(400),
  });
  assert.equal(typeof long.context.last_user_prompt, "string");
  assert.match(long.context.last_user_prompt, /\[truncated 400 bytes\]$/);
});

test("buildCheckBody omits the last user prompt when absent or disabled", () => {
  assert.equal("last_user_prompt" in buildCheckBody({}, TEST_CONFIG).context, false);
  assert.equal(
    "last_user_prompt" in buildCheckBody({}, TEST_CONFIG, { lastUserPrompt: null }).context,
    false,
  );
  assert.equal(
    "last_user_prompt" in buildCheckBody({}, TEST_CONFIG, { lastUserPrompt: "" }).context,
    false,
  );
  assert.equal(
    "last_user_prompt" in
      buildCheckBody({ }, { ...TEST_CONFIG, includeLastUserPrompt: false }, {
        lastUserPrompt: "run whoami",
      }).context,
    false,
  );
});

test("buildCheckBody redacts before truncating in both context slots", () => {
  const input = {
    toolCall: {
      name: "run_command",
      args: { token: "dn_live_supersecret", CommandLine: "x".repeat(400) },
    },
  };
  const body = buildCheckBody(input, { ...TEST_CONFIG, maxContextBytes: 60 });
  assert.equal(body.resource.properties.tool_input.truncated, true);
  assert.equal(
    JSON.stringify(body.resource.properties.tool_input).includes("supersecret"),
    false,
  );
  assert.equal(JSON.stringify(body.context.hook_payload).includes("supersecret"), false);
});

test("buildCheckBody does not mutate the payload it is given", () => {
  const input = capturedPayload({
    toolCall: { name: "run_command", args: { CommandLine: "deploy", token: "s" } },
  });
  buildCheckBody(input, TEST_CONFIG);
  assert.equal(input.toolCall.args.token, "s");
  assert.equal(input.toolCall.args.CommandLine, "deploy");
});

// ===========================================================================
// §8.1 — Transcript / last user prompt
// ===========================================================================

test("resolveTranscriptPath expands a tilde-prefixed path", () => {
  assert.equal(
    resolveTranscriptPath("~/.gemini/antigravity-cli/brain/x/t.jsonl", [], "/cwd", "/home/dev"),
    "/home/dev/.gemini/antigravity-cli/brain/x/t.jsonl",
  );
});

test("resolveTranscriptPath passes an absolute path through", () => {
  assert.equal(
    resolveTranscriptPath("/abs/t.jsonl", ["/ws"], "/cwd", "/home/dev"),
    "/abs/t.jsonl",
  );
});

test("resolveTranscriptPath resolves a workspace-relative path against the first workspace", () => {
  // The hook's cwd is the directory containing hooks.json, so a relative path
  // must never be resolved against it when a workspace root is known.
  assert.equal(
    resolveTranscriptPath(".gemini/x/t.jsonl", ["/ws", "/other"], "/cwd", "/home/dev"),
    "/ws/.gemini/x/t.jsonl",
  );
  assert.equal(
    resolveTranscriptPath(".gemini/x/t.jsonl", [], "/cwd", "/home/dev"),
    "/cwd/.gemini/x/t.jsonl",
  );
  assert.equal(
    resolveTranscriptPath(".gemini/t.jsonl", [42, ""], "/cwd", "/home/dev"),
    "/cwd/.gemini/t.jsonl",
  );
});

test("resolveTranscriptPath returns null for an absent path", () => {
  assert.equal(resolveTranscriptPath(undefined, [], "/cwd", "/home/dev"), null);
  assert.equal(resolveTranscriptPath("", [], "/cwd", "/home/dev"), null);
  assert.equal(resolveTranscriptPath(42, [], "/cwd", "/home/dev"), null);
});

test("transcriptCandidates prefers transcript_full.jsonl", () => {
  // transcript.jsonl double-encodes tool-call args; the _full sibling does not.
  assert.deepEqual(transcriptCandidates("/a/b/transcript.jsonl"), [
    "/a/b/transcript_full.jsonl",
    "/a/b/transcript.jsonl",
  ]);
  assert.deepEqual(transcriptCandidates("/a/b/transcript_full.jsonl"), [
    "/a/b/transcript_full.jsonl",
  ]);
  assert.deepEqual(transcriptCandidates("/a/b/other.jsonl"), ["/a/b/other.jsonl"]);
  assert.deepEqual(transcriptCandidates(null), []);
});

test("extractLastUserPrompt unwraps the <USER_REQUEST> block", () => {
  const text = `${PLANNER_LINE}\n${userInputLine("run whoami")}\n`;
  assert.equal(extractLastUserPrompt(text), "run whoami");
});

test("extractLastUserPrompt returns the newest USER_INPUT scanning backwards", () => {
  const text = [
    userInputLine("first prompt"),
    PLANNER_LINE,
    userInputLine("second prompt"),
    PLANNER_LINE,
    "",
  ].join("\n");
  assert.equal(extractLastUserPrompt(text), "second prompt");
});

test("extractLastUserPrompt ignores CHECKPOINT records that restate the prompt", () => {
  const text = [userInputLine("run whoami"), CHECKPOINT_LINE, ""].join("\n");
  assert.equal(extractLastUserPrompt(text), "run whoami");
});

test("extractLastUserPrompt is non-greedy across trailing metadata blocks", () => {
  const settings =
    "\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection`.\n</USER_SETTINGS_CHANGE>";
  assert.equal(extractLastUserPrompt(`${userInputLine("run pwd", settings)}\n`), "run pwd");
});

test("extractLastUserPrompt handles a multi-line prompt", () => {
  assert.equal(
    extractLastUserPrompt(`${userInputLine("line one\nline two")}\n`),
    "line one\nline two",
  );
});

test("extractLastUserPrompt falls back to the raw content when the wrapper is absent", () => {
  const line = JSON.stringify({
    step_index: 3,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: "2026-08-04T23:42:14Z",
    content: "bare prompt with no wrapper",
  });
  assert.equal(extractLastUserPrompt(`${line}\n`), "bare prompt with no wrapper");
});

test("extractLastUserPrompt skips a partial first line from a mid-file tail read", () => {
  const partial = '{"step_index":9,"source":"MODEL","type":"PLANN';
  assert.equal(
    extractLastUserPrompt(`${partial}\n${userInputLine("run whoami")}\n`),
    "run whoami",
  );
});

test("extractLastUserPrompt skips USER_INPUT records without string content", () => {
  const noContent = JSON.stringify({ type: "USER_INPUT", source: "USER_EXPLICIT" });
  const objectContent = JSON.stringify({ type: "USER_INPUT", content: { text: "x" } });
  const text = [userInputLine("run whoami"), noContent, objectContent, ""].join("\n");
  assert.equal(extractLastUserPrompt(text), "run whoami");
});

test("extractLastUserPrompt returns null on garbage, empty or non-user transcripts", () => {
  assert.equal(extractLastUserPrompt(""), null);
  assert.equal(extractLastUserPrompt("   \n\n"), null);
  assert.equal(extractLastUserPrompt("not json at all\n{oops\n"), null);
  assert.equal(extractLastUserPrompt(`${PLANNER_LINE}\n${CHECKPOINT_LINE}\n`), null);
  assert.equal(extractLastUserPrompt("null\n[1,2]\n"), null);
  assert.equal(extractLastUserPrompt(undefined), null);
  assert.equal(extractLastUserPrompt(null), null);
});

test("readLastUserPrompt reads a real transcript file", async () => {
  const dir = await tmpDir("brain");
  const file = path.join(dir, "transcript_full.jsonl");
  await fs.writeFile(file, `${PLANNER_LINE}\n${userInputLine("run whoami")}\n`, "utf-8");
  assert.equal(await readLastUserPrompt(file), "run whoami");
});

test("readLastUserPrompt prefers the _full sibling when handed transcript.jsonl", async () => {
  const dir = await tmpDir("brain");
  await fs.writeFile(
    path.join(dir, "transcript.jsonl"),
    `${userInputLine("plain file prompt")}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "transcript_full.jsonl"),
    `${userInputLine("full file prompt")}\n`,
    "utf-8",
  );
  assert.equal(
    await readLastUserPrompt(path.join(dir, "transcript.jsonl")),
    "full file prompt",
  );
});

test("readLastUserPrompt falls back to transcript.jsonl when _full is missing", async () => {
  const dir = await tmpDir("brain");
  await fs.writeFile(
    path.join(dir, "transcript.jsonl"),
    `${userInputLine("plain file prompt")}\n`,
    "utf-8",
  );
  assert.equal(
    await readLastUserPrompt(path.join(dir, "transcript.jsonl")),
    "plain file prompt",
  );
});

test("readLastUserPrompt reads only the tail window", async () => {
  const dir = await tmpDir("brain");
  const file = path.join(dir, "transcript_full.jsonl");
  const filler = `${PLANNER_LINE}\n`.repeat(200);
  await fs.writeFile(
    file,
    `${userInputLine("ancient prompt")}\n${filler}${userInputLine("recent prompt")}\n`,
    "utf-8",
  );
  assert.equal(await readLastUserPrompt(file, 512), "recent prompt");
  assert.equal(await readLastUserPrompt(file, DEFAULT_TAIL_BYTES), "recent prompt");
});

test("readLastUserPrompt is best-effort: missing, empty and unusable files yield null", async () => {
  const dir = await tmpDir("brain");
  const empty = path.join(dir, "transcript_full.jsonl");
  await fs.writeFile(empty, "", "utf-8");

  assert.equal(await readLastUserPrompt(null), null);
  assert.equal(await readLastUserPrompt(path.join(dir, "nope.jsonl")), null);
  assert.equal(await readLastUserPrompt(empty), null);
  assert.equal(await readLastUserPrompt(dir), null); // a directory, not a file
});

// ===========================================================================
// §8.1 — Decision shaping (the output contract, §5.4)
// ===========================================================================

test("interpretDecision allows on decision === true", () => {
  assert.deepEqual(interpretDecision({ decision: true }), { kind: "allow", reason: "" });
  assert.equal(interpretDecision({ decision: true, context: { reason: "ok" } }).reason, "ok");
});

test("interpretDecision denies on decision === false and never without a reason", () => {
  // A reason-less denial pushes the agent into fabricating answers (§0.5 item 7).
  assert.deepEqual(interpretDecision({ decision: false }), {
    kind: "deny",
    reason: "Authorization denied by Denied policy engine.",
  });
  assert.equal(
    interpretDecision({ decision: false, context: { reason: "blocked: rm" } }).reason,
    "blocked: rm",
  );
  assert.equal(interpretDecision({ decision: false, context: { reason: 42 } }).reason.length > 0, true);
  assert.equal(interpretDecision({ decision: false, context: null }).reason.length > 0, true);
});

test("interpretDecision errors on a missing or non-boolean decision", () => {
  for (const body of [{}, { decision: "yes" }, { decision: null }, { decision: 1 }, { foo: 1 }]) {
    const outcome = interpretDecision(body);
    assert.equal(outcome.kind, "error", JSON.stringify(body));
    assert.match(outcome.reason, /missing or invalid 'decision'/);
  }
});

test("interpretDecision tolerates a non-object response", () => {
  for (const body of [null, undefined, "yes", 42, [1, 2]]) {
    assert.equal(interpretDecision(body).kind, "error");
  }
});

test("resolveFailSafe maps every fail mode onto the documented enum", () => {
  assert.deepEqual(resolveFailSafe("open", "boom"), {
    decision: "allow",
    reason: "Denied policy engine unavailable and fail-mode is open. boom",
  });
  assert.deepEqual(resolveFailSafe("closed", "boom"), {
    decision: "deny",
    reason: "Denied policy engine unavailable and fail-mode is closed. boom",
  });
  assert.deepEqual(resolveFailSafe("ask", "boom"), {
    decision: "force_ask",
    reason: "Denied policy engine unavailable and fail-mode is ask. boom",
  });
});

test("resolveFailSafe treats any unrecognized mode as open and always gives a reason", () => {
  for (const mode of ["whatever", "", undefined, null, 0, {}, "OPEN"]) {
    const outcome = resolveFailSafe(mode, "boom");
    assert.equal(outcome.decision, "allow", String(mode));
    assert.ok(outcome.reason.length > 0);
  }
  assert.equal(resolveFailSafe("closed", "").reason.endsWith("closed."), true);
});

test("resolveFailSafe never yields a decision outside the enum", () => {
  for (const mode of [...FAIL_MODES, "nonsense", undefined, null, 42, "", "Closed"]) {
    const { decision } = resolveFailSafe(mode, "boom");
    assert.ok(VALID_DECISIONS.includes(decision), String(mode));
    assert.notEqual(decision, "block");
  }
});

test("buildDecisionOutput always carries a decision and never emits {}", () => {
  // `{}` is not an allow on this platform — it denies.
  assert.deepEqual(buildDecisionOutput("allow", ""), { decision: "allow" });
  assert.deepEqual(buildDecisionOutput("allow"), { decision: "allow" });
  assert.deepEqual(buildDecisionOutput("deny", "nope"), { decision: "deny", reason: "nope" });
  assert.deepEqual(buildDecisionOutput("force_ask", "ask me"), {
    decision: "force_ask",
    reason: "ask me",
  });
  assert.deepEqual(buildDecisionOutput("deny", 42), { decision: "deny" });
  for (const decision of VALID_DECISIONS) {
    assert.equal("decision" in buildDecisionOutput(decision, undefined), true);
    assert.notEqual(JSON.stringify(buildDecisionOutput(decision, undefined)), "{}");
  }
});

test("buildDecisionOutput serializes the deny path exactly as the host expects", () => {
  assert.equal(
    JSON.stringify(buildDecisionOutput("deny", "nope")),
    '{"decision":"deny","reason":"nope"}',
  );
});

test("emitDecision writes once and suppresses every later call", () => {
  // A late timer firing after a successful emit would produce two JSON objects
  // and an invalid payload.
  resetEmitState();
  try {
    const written = [];
    assert.equal(hasEmitted(), false);
    assert.equal(emitDecision("allow", "", (text) => written.push(text)), true);
    assert.equal(hasEmitted(), true);
    assert.equal(emitDecision("deny", "late", (text) => written.push(text)), false);
    assert.equal(emitDecision("force_ask", "later still", (text) => written.push(text)), false);
    assert.deepEqual(written, ['{"decision":"allow"}']);
  } finally {
    resetEmitState();
  }
});

test("emitDecision emits the reason when there is one", () => {
  resetEmitState();
  try {
    const written = [];
    emitDecision("deny", "nope", (text) => written.push(text));
    assert.deepEqual(written, ['{"decision":"deny","reason":"nope"}']);
  } finally {
    resetEmitState();
  }
});

// ===========================================================================
// §8.1 — stdin and audit
// ===========================================================================

test("readStdin parses a streamed hook payload", async () => {
  const payload = capturedPayload();
  const stream = Readable.from([Buffer.from(JSON.stringify(payload), "utf-8")]);
  assert.deepEqual(await readStdin(stream, 1000), payload);
});

test("readStdin degrades unusable input to {}", async () => {
  assert.deepEqual(await readStdin(Readable.from([Buffer.from("not json")]), 1000), {});
  assert.deepEqual(await readStdin(Readable.from([]), 1000), {});
});

test("readStdin gives up at its deadline instead of hanging", async () => {
  const stream = new PassThrough();
  const started = Date.now();
  assert.deepEqual(await readStdin(stream, 120), {});
  assert.ok(Date.now() - started >= 100, "returned before the deadline");
  assert.ok(Date.now() - started < 3000, "outlived the deadline");
});

test("readStdin keeps whatever arrived before the deadline", async () => {
  const stream = new PassThrough();
  stream.write(JSON.stringify({ toolCall: { name: "run_command" } }));
  // Deliberately never ended: the host may not close the pipe.
  assert.deepEqual(await readStdin(stream, 150), { toolCall: { name: "run_command" } });
});

test("appendAuditRecord writes the configured sections", async () => {
  const dir = await tmpDir("audit");
  await appendAuditRecord(
    { toolCall: { name: "run_command", args: { CommandLine: "ls" } } },
    { resource: { id: "run_command" } },
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
  const raw = await fs.readFile(path.join(dir, "denied-antigravity-hook.jsonl"), "utf-8");
  assert.equal(raw.endsWith("\n"), true);
  const record = JSON.parse(raw);
  assert.deepEqual(Object.keys(record).sort(), ["decision", "hook_payload", "timestamp"]);
  assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(record.hook_payload, {
    toolCall: { name: "run_command", args: { CommandLine: "ls" } },
  });
});

test("appendAuditRecord appends one line per call", async () => {
  const dir = await tmpDir("audit");
  const config = { ...TEST_CONFIG, audit: { ...TEST_CONFIG.audit, enabled: true, dir } };
  await appendAuditRecord({}, {}, { decision: true }, config);
  await appendAuditRecord({}, {}, { decision: false }, config);
  const raw = await fs.readFile(path.join(dir, "denied-antigravity-hook.jsonl"), "utf-8");
  assert.equal(raw.trim().split("\n").length, 2);
});

test("appendAuditRecord redacts the raw payload it stores", async () => {
  const dir = await tmpDir("audit");
  await appendAuditRecord(
    { toolCall: { name: "run_command", args: { api_key: "dn_live_secret" } } },
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
  const raw = await fs.readFile(path.join(dir, "denied-antigravity-hook.jsonl"), "utf-8");
  assert.equal(raw.includes("dn_live_secret"), false);
  assert.equal(raw.includes("[REDACTED]"), true);
});

test("appendAuditRecord writes nothing when auditing is disabled", async () => {
  const dir = await tmpDir("audit");
  await appendAuditRecord({}, {}, {}, {
    ...TEST_CONFIG,
    audit: { ...TEST_CONFIG.audit, enabled: false, dir },
  });
  assert.deepEqual(await fs.readdir(dir), []);
});

test("appendAuditRecord never throws when the audit directory is unusable", async () => {
  // Audit is observability, never a gate on the decision. (The warning it
  // writes lands on stderr, which is why nothing is asserted about stdout —
  // H12 covers the same path end-to-end through a subprocess.)
  const file = tmpPath("not-a-dir");
  await fs.writeFile(file, "x", "utf-8");
  const nested = path.join(file, "nested");
  await appendAuditRecord({}, {}, {}, {
    ...TEST_CONFIG,
    audit: { ...TEST_CONFIG.audit, enabled: true, dir: nested },
  });
  await assert.rejects(() => fs.readdir(nested));
});

// ===========================================================================
// §8.2 — Failure-regime hazard tests (real subprocesses)
//
// Every scenario below is one where a naive implementation exits non-zero or
// prints nothing — which silently denies every tool call on agy <= 1.1.7 and
// silently stops enforcing on 1.1.10. Each therefore asserts exit 0 plus one
// well-formed decision, and each fail-safe path runs under both failMode: open
// and failMode: closed.
// ===========================================================================

// --- H1: crash -------------------------------------------------------------

test("H1: an uncaught exception still emits the configured fail-safe decision", { timeout: 30000 }, async () => {
  const preload = await writePreload(
    "preload-throw.js",
    // Thrown after the interceptor has installed its handlers, while main() is
    // parked on a fetch that never resolves — so the crash wins the race. The
    // delay has to clear module load even on a slow CI runner, or the process
    // would die before the handlers exist and the test would fail loudly.
    'setTimeout(() => { throw new Error("denied-test-forced-crash"); }, 400);\n',
  );
  await withServer(
    () => startStubServer(() => {}),
    async (server) => {
      const [open, closed] = await Promise.all([
        runInterceptor({
          preload,
          stdin: JSON.stringify(capturedPayload()),
          env: childEnv({
            DENIED_URL: server.url,
            DENIED_API_KEY: "dn_test",
            DENIED_FAIL_MODE: "open",
          }),
        }),
        runInterceptor({
          preload,
          stdin: JSON.stringify(capturedPayload()),
          env: childEnv({
            DENIED_URL: server.url,
            DENIED_API_KEY: "dn_test",
            DENIED_FAIL_MODE: "closed",
          }),
        }),
      ]);

      assert.equal(assertDecision(open, "H1 open").decision, "allow");
      // The direction that matters on a fail-open host: a crash must not
      // silently stop enforcing for a failMode: closed user.
      assert.equal(assertDecision(closed, "H1 closed").decision, "deny");
      assert.match(open.stderr, /denied-test-forced-crash/);
    },
  );
});

// --- H2: unhandled rejection ----------------------------------------------

test("H2: an unhandled rejection still emits the configured fail-safe decision", { timeout: 30000 }, async () => {
  const preload = await writePreload(
    "preload-reject.js",
    'setTimeout(() => { Promise.reject(new Error("denied-test-unhandled-rejection")); }, 400);\n',
  );
  await withServer(
    () => startStubServer(() => {}),
    async (server) => {
      const [open, closed] = await Promise.all([
        runInterceptor({
          preload,
          stdin: "{}",
          env: childEnv({
            DENIED_URL: server.url,
            DENIED_API_KEY: "dn_test",
            DENIED_FAIL_MODE: "open",
          }),
        }),
        runInterceptor({
          preload,
          stdin: "{}",
          env: childEnv({
            DENIED_URL: server.url,
            DENIED_API_KEY: "dn_test",
            DENIED_FAIL_MODE: "closed",
          }),
        }),
      ]);

      assert.equal(assertDecision(open, "H2 open").decision, "allow");
      assert.equal(assertDecision(closed, "H2 closed").decision, "deny");
      assert.match(open.stderr, /denied-test-unhandled-rejection/);
    },
  );
});

// --- H3: PDP down ----------------------------------------------------------

test("H3: a closed PDP port emits the fail-safe decision in both directions", { timeout: 30000 }, async () => {
  const url = await closedPortUrl();
  const [open, closed] = await Promise.all([
    runInterceptor({
      stdin: JSON.stringify(capturedPayload()),
      env: childEnv({ DENIED_URL: url, DENIED_API_KEY: "dn_test", DENIED_FAIL_MODE: "open" }),
    }),
    runInterceptor({
      stdin: JSON.stringify(capturedPayload()),
      env: childEnv({ DENIED_URL: url, DENIED_API_KEY: "dn_test", DENIED_FAIL_MODE: "closed" }),
    }),
  ]);

  const openDecision = assertDecision(open, "H3 open");
  assert.equal(openDecision.decision, "allow");
  assert.match(openDecision.reason, /unavailable and fail-mode is open/);
  const closedDecision = assertDecision(closed, "H3 closed");
  assert.equal(closedDecision.decision, "deny");
  assert.match(closedDecision.reason, /unavailable and fail-mode is closed/);
  assert.match(open.stderr, /Failed to reach Denied PDP/);
});

test("H3: failMode ask maps an unreachable PDP to force_ask", { timeout: 30000 }, async () => {
  const url = await closedPortUrl();
  const result = await runInterceptor({
    stdin: JSON.stringify(capturedPayload()),
    env: childEnv({ DENIED_URL: url, DENIED_API_KEY: "dn_test", DENIED_FAIL_MODE: "ask" }),
  });
  const decision = assertDecision(result, "H3 ask");
  assert.equal(decision.decision, "force_ask");
  assert.match(decision.reason, /fail-mode is ask/);
});

// --- H4: PDP slow ----------------------------------------------------------

test("H4: a PDP that never responds aborts inside the watchdog budget", { timeout: 40000 }, async () => {
  // Regression guard for the 120 s hang in cmux#5358 / #8921.
  await withServer(
    () => startStubServer(() => {}),
    async (server) => {
      const [open, closed] = await Promise.all([
        runInterceptor({
          stdin: JSON.stringify(capturedPayload()),
          env: childEnv({
            DENIED_URL: server.url,
            DENIED_API_KEY: "dn_test",
            DENIED_FAIL_MODE: "open",
          }),
        }),
        runInterceptor({
          stdin: JSON.stringify(capturedPayload()),
          env: childEnv({
            DENIED_URL: server.url,
            DENIED_API_KEY: "dn_test",
            DENIED_FAIL_MODE: "closed",
          }),
        }),
      ]);

      assert.equal(assertDecision(open, "H4 open").decision, "allow");
      assert.equal(assertDecision(closed, "H4 closed").decision, "deny");
      for (const result of [open, closed]) {
        // The fetch deadline must resolve this, not the watchdog.
        assert.ok(
          result.durationMs < WATCHDOG_MS,
          `expected the fetch abort to win (took ${result.durationMs}ms)`,
        );
      }
      assert.equal(server.requests.length, 2);
    },
  );
});

test("H4: the watchdog fires when even the fetch deadline cannot", { timeout: 40000 }, async () => {
  // The last line of defence: a fetch that ignores its abort signal entirely.
  const preload = await writePreload(
    "preload-frozen-fetch.js",
    "globalThis.fetch = () => new Promise(() => {});\n",
  );
  const result = await runInterceptor({
    preload,
    stdin: JSON.stringify(capturedPayload()),
    env: childEnv({
      DENIED_URL: "http://127.0.0.1:1",
      DENIED_API_KEY: "dn_test",
      DENIED_FAIL_MODE: "closed",
    }),
  });

  const decision = assertDecision(result, "H4 watchdog");
  assert.equal(decision.decision, "deny");
  assert.match(decision.reason, /Watchdog fired/);
  assert.ok(
    result.durationMs >= WATCHDOG_MS - 500,
    `watchdog fired too early (${result.durationMs}ms)`,
  );
  // Generous headroom above the watchdog: process startup happens before the
  // timer is armed, and a loaded CI runner adds more.
  assert.ok(
    result.durationMs < WATCHDOG_MS + 2000,
    `watchdog fired too late (${result.durationMs}ms)`,
  );
});

// --- H5: stdin never closes ------------------------------------------------

test("H5: an stdin pipe that never closes resolves at the stdin deadline", { timeout: 30000 }, async () => {
  await withServer(
    () => jsonServer(ALLOW_BODY),
    async (server) => {
      const result = await runInterceptor({
        keepStdinOpen: true,
        env: childEnv({ DENIED_URL: server.url, DENIED_API_KEY: "dn_test" }),
      });

      assert.equal(assertDecision(result, "H5").decision, "allow");
      assert.ok(
        result.durationMs >= DEFAULT_STDIN_TIMEOUT_MS - 300,
        `returned before the stdin deadline (${result.durationMs}ms)`,
      );
      assert.ok(
        result.durationMs < WATCHDOG_MS,
        `outlived the watchdog (${result.durationMs}ms)`,
      );
      // The check still goes out with "unknown" ids.
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0].json.resource.id, "unknown");
    },
  );
});

// --- H6 / H7: malformed and empty stdin ------------------------------------

for (const [label, stdin] of [
  ["H6: malformed stdin", "not json at all"],
  ["H7: empty stdin", ""],
]) {
  test(`${label} still sends the check with unknown ids`, { timeout: 30000 }, async () => {
    // A garbage payload is not a reason to stop asking the PDP.
    await withServer(
      () => jsonServer({ decision: false, context: { reason: "policy says no" } }),
      async (server) => {
        const result = await runInterceptor({
          stdin,
          env: childEnv({ DENIED_URL: server.url, DENIED_API_KEY: "dn_test" }),
        });

        const decision = assertDecision(result, label);
        assert.equal(decision.decision, "deny");
        assert.equal(decision.reason, "policy says no");
        assert.equal(server.requests.length, 1);
        const body = server.requests[0].json;
        assert.equal(body.resource.id, "unknown");
        assert.equal(body.subject.id, "unknown");
        assert.equal(body.context.hook_event_name, "PreToolUse");
      },
    );
  });

  test(`${label} falls back safely when no check can be made`, { timeout: 30000 }, async () => {
    const [open, closed] = await Promise.all([
      runInterceptor({ stdin, env: childEnv({ DENIED_FAIL_MODE: "open" }) }),
      runInterceptor({ stdin, env: childEnv({ DENIED_FAIL_MODE: "closed" }) }),
    ]);
    assert.equal(assertDecision(open, `${label} open`).decision, "allow");
    assert.equal(assertDecision(closed, `${label} closed`).decision, "deny");
  });
}

// --- H8: missing API key ---------------------------------------------------

test("H8: a missing API key emits the fail-safe decision and explains on stderr", { timeout: 30000 }, async () => {
  const [open, closed] = await Promise.all([
    runInterceptor({
      stdin: JSON.stringify(capturedPayload()),
      env: childEnv({ DENIED_FAIL_MODE: "open" }),
    }),
    runInterceptor({
      stdin: JSON.stringify(capturedPayload()),
      env: childEnv({ DENIED_FAIL_MODE: "closed" }),
    }),
  ]);

  assert.equal(assertDecision(open, "H8 open").decision, "allow");
  assert.equal(assertDecision(closed, "H8 closed").decision, "deny");
  for (const result of [open, closed]) {
    assert.match(result.stderr, /No API key found/);
  }
});

// --- H9: malformed config file ---------------------------------------------

test("H9: a malformed config file warns on stderr and still decides", { timeout: 30000 }, async () => {
  const badConfig = tmpPath("broken-config.json");
  await fs.writeFile(badConfig, "{ apiKey: 'unquoted', ", "utf-8");

  const [open, closed] = await Promise.all([
    runInterceptor({
      stdin: JSON.stringify(capturedPayload()),
      env: childEnv({ DENIED_CONFIG: badConfig, DENIED_FAIL_MODE: "open" }),
    }),
    runInterceptor({
      stdin: JSON.stringify(capturedPayload()),
      env: childEnv({ DENIED_CONFIG: badConfig, DENIED_FAIL_MODE: "closed" }),
    }),
  ]);

  assert.equal(assertDecision(open, "H9 open").decision, "allow");
  assert.equal(assertDecision(closed, "H9 closed").decision, "deny");
  for (const result of [open, closed]) {
    assert.match(result.stderr, /Ignoring malformed config file/);
  }
});

// --- H10: PDP returns garbage ----------------------------------------------

const GARBAGE_RESPONSES = [
  ["a JSON body with no decision field", () => jsonServer({ foo: 1 })],
  ["an HTTP 500", () => jsonServer({ error: "boom" }, 500)],
  [
    "a non-JSON body",
    () =>
      startStubServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>gateway</html>");
      }),
  ],
];

for (const [label, factory] of GARBAGE_RESPONSES) {
  test(`H10: ${label} takes the fail-safe path in both directions`, { timeout: 30000 }, async () => {
    await withServer(factory, async (server) => {
      const [open, closed] = await Promise.all([
        runInterceptor({
          stdin: JSON.stringify(capturedPayload()),
          env: childEnv({
            DENIED_URL: server.url,
            DENIED_API_KEY: "dn_test",
            DENIED_FAIL_MODE: "open",
          }),
        }),
        runInterceptor({
          stdin: JSON.stringify(capturedPayload()),
          env: childEnv({
            DENIED_URL: server.url,
            DENIED_API_KEY: "dn_test",
            DENIED_FAIL_MODE: "closed",
          }),
        }),
      ]);

      assert.equal(assertDecision(open, `H10 open (${label})`).decision, "allow");
      assert.equal(assertDecision(closed, `H10 closed (${label})`).decision, "deny");
    });
  });
}

// --- H11: stdout purity ----------------------------------------------------

test("H11: stdout carries exactly one JSON object even with audit and warnings on", { timeout: 30000 }, async () => {
  // A stray console.log would corrupt the payload into a denial.
  const auditDir = await tmpDir("h11-audit");
  const configPath = await writeJson(tmpPath("h11-config.json"), {
    apiKey: "dn_file",
    // Both of these emit a warning on stderr during config resolution.
    failMode: "bogus-mode",
    timeoutMs: 999_999,
    audit: { enabled: true, dir: auditDir },
  });

  await withServer(
    () => jsonServer(ALLOW_BODY),
    async (server) => {
      const result = await runInterceptor({
        stdin: JSON.stringify(capturedPayload()),
        env: childEnv({ DENIED_CONFIG: configPath, DENIED_URL: server.url }),
      });

      const decision = assertDecision(result, "H11");
      assert.equal(decision.decision, "allow");
      // Byte-exact: no newline, no banner, nothing but the decision.
      assert.equal(result.stdout, JSON.stringify(decision));
      assert.equal(result.stdout, '{"decision":"allow"}');

      // The noise all went to stderr.
      assert.match(result.stderr, /Unknown failMode/);
      assert.match(result.stderr, /clamping to/);

      const audit = await fs.readFile(
        path.join(auditDir, "denied-antigravity-hook.jsonl"),
        "utf-8",
      );
      assert.equal(audit.trim().split("\n").length, 1);
      assert.equal(JSON.parse(audit).decision.decision, true);
    },
  );
});

// --- H12: unwritable audit directory ---------------------------------------

test("H12: an unwritable audit directory never affects the decision", { timeout: 30000 }, async () => {
  if (process.platform === "win32" || (process.getuid && process.getuid() === 0)) {
    // chmod is meaningless for root and on Windows.
    return;
  }
  const readOnly = await tmpDir("h12-readonly");
  await fs.chmod(readOnly, 0o555);
  try {
    const configPath = await writeJson(tmpPath("h12-config.json"), {
      apiKey: "dn_file",
      audit: { enabled: true, dir: path.join(readOnly, "nested") },
    });

    await withServer(
      () => jsonServer({ decision: false, context: { reason: "policy says no" } }),
      async (server) => {
        const result = await runInterceptor({
          stdin: JSON.stringify(capturedPayload()),
          env: childEnv({ DENIED_CONFIG: configPath, DENIED_URL: server.url }),
        });

        const decision = assertDecision(result, "H12");
        assert.equal(decision.decision, "deny");
        assert.equal(decision.reason, "policy says no");
        assert.match(result.stderr, /Failed to write audit record/);
      },
    );
  } finally {
    await fs.chmod(readOnly, 0o755);
  }
});

// --- H13: huge payload -----------------------------------------------------

test("H13: a 10 MB tool-call payload is truncated and still decided in budget", { timeout: 40000 }, async () => {
  const huge = JSON.stringify({
    ...capturedPayload(),
    toolCall: {
      name: "write_to_file",
      args: { TargetFile: "/w/p/big.txt", CodeContent: "x".repeat(10 * 1024 * 1024) },
    },
  });
  assert.ok(huge.length > 10 * 1024 * 1024);

  await withServer(
    () => jsonServer(ALLOW_BODY),
    async (server) => {
      const result = await runInterceptor({
        stdin: huge,
        env: childEnv({ DENIED_URL: server.url, DENIED_API_KEY: "dn_test" }),
      });

      assert.equal(assertDecision(result, "H13").decision, "allow");
      assert.ok(result.durationMs < WATCHDOG_MS, `took ${result.durationMs}ms`);

      assert.equal(server.requests.length, 1);
      const { raw, json } = server.requests[0];
      // The PDP must not be handed 10 MB: both context slots are bounded at
      // maxContextBytes (20 KB by default).
      assert.ok(raw.length < 200_000, `PDP received ${raw.length} bytes`);
      assert.equal(json.resource.properties.tool_input.truncated, true);
      assert.equal(json.resource.properties.tool_input.max_bytes, 20000);
      assert.equal(json.context.hook_payload.truncated, true);
      assert.equal(json.resource.id, "write_to_file");
      assert.equal(json.action.properties.effect, "create");
    },
  );
});

// --- End-to-end allow / deny ------------------------------------------------

test("the deny path emits exactly the PDP's reason", { timeout: 30000 }, async () => {
  await withServer(
    () => jsonServer({ decision: false, context: { reason: "nope" } }),
    async (server) => {
      const result = await runInterceptor({
        stdin: JSON.stringify(capturedPayload()),
        env: childEnv({ DENIED_URL: server.url, DENIED_API_KEY: "dn_test" }),
      });

      assert.equal(result.code, 0);
      assert.equal(result.stdout, '{"decision":"deny","reason":"nope"}');
      // The blocked tool call is named on stderr, never on stdout.
      assert.match(result.stderr, /Blocked tool call: run_command/);
    },
  );
});

test("the allow path emits a bare allow and sends a well-formed check", { timeout: 30000 }, async () => {
  await withServer(
    () => jsonServer(ALLOW_BODY),
    async (server) => {
      const result = await runInterceptor({
        stdin: JSON.stringify(capturedPayload()),
        env: childEnv({ DENIED_URL: server.url, DENIED_API_KEY: "dn_test" }),
      });

      assert.equal(result.code, 0);
      assert.equal(result.stdout, '{"decision":"allow"}');

      const request = server.requests[0];
      assert.equal(request.url, "/pdp/check");
      assert.equal(request.headers["x-api-key"], "dn_test");
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(request.json.subject.type, "antigravity");
      assert.equal(request.json.subject.id, "435c93dd-d1ea-4fac-988d-c8e1eb9f5c76");
      assert.equal(request.json.subject.properties.surface, "cli");
      assert.equal(request.json.resource.id, "run_command");
      assert.equal(request.json.context.integration, "denied-antigravity-hook");
    },
  );
});

test("a denial with no reason still carries one", { timeout: 30000 }, async () => {
  // A reason-less denial pushes the agent into fabricating answers.
  await withServer(
    () => jsonServer({ decision: false }),
    async (server) => {
      const result = await runInterceptor({
        stdin: JSON.stringify(capturedPayload()),
        env: childEnv({ DENIED_URL: server.url, DENIED_API_KEY: "dn_test" }),
      });
      const decision = assertDecision(result, "reasonless deny");
      assert.equal(decision.decision, "deny");
      assert.ok(decision.reason.length > 0);
    },
  );
});

test("the interceptor reads its settings from the config file when env is empty", { timeout: 30000 }, async () => {
  await withServer(
    () => jsonServer(ALLOW_BODY),
    async (server) => {
      const configPath = await writeJson(tmpPath("file-only-config.json"), {
        apiKey: "dn_from_file",
        url: server.url,
        surface: "app",
        request: { includeHookPayload: false, includeLastUserPrompt: false },
      });
      const result = await runInterceptor({
        stdin: JSON.stringify(
          // No profile marker in either path, so the surface can only come
          // from the config file.
          capturedPayload({
            artifactDirectoryPath: "/elsewhere/brain/x",
            transcriptPath: "/elsewhere/brain/x/transcript.jsonl",
          }),
        ),
        // No DENIED_* env at all beyond the config path — the GUI case.
        env: childEnv({ DENIED_CONFIG: configPath }),
      });

      assert.equal(assertDecision(result, "file config").decision, "allow");
      const body = server.requests[0].json;
      assert.equal(server.requests[0].headers["x-api-key"], "dn_from_file");
      assert.equal(body.subject.properties.surface, "app");
      assert.equal("hook_payload" in body.context, false);
    },
  );
});

// ===========================================================================
// §8.3 — Regression guards for the adversarial review rounds
//
// Everything below shipped past the suite above. Each test is named for the
// finding it pins (R1–R13) so a red run in CI identifies the regression rather
// than the helper that noticed it.
// ===========================================================================

// --- Linearity harness (R1, R8) --------------------------------------------
//
// Every pattern that runs on model-controlled text has to cost linear time in
// the length of that text: the work is synchronous, so neither the watchdog
// timer nor a signal handler can preempt it, and the host's own timeout decides
// the tool call instead of us. Three of these shipped (the authorization
// whitespace pair, `echo(?!\s.*>)`, `add_.*_member`), so the guard is a *dual*
// bound, because either half alone is defeatable:
//
//   1. an absolute floor — catches a regression that keeps a byte-cap shield
//      (MAX_REDACT_STRING_BYTES, MAX_TOOL_NAME_BYTES) but reverts the pattern,
//      where the input never grows large enough for a ratio to blow up;
//   2. a ratio against a *same-length* benign control that matches nothing —
//      machine-independent, which is what keeps this stable on a shared CI
//      runner. Healthy ratios measured on this repo's inputs are 0.6–8.2;
//      the pre-fix patterns score 324–16,289 (see the R1/R8 probes below).
//
// Every control is the hostile input with a single character changed, so the
// two differ in what they match and in nothing else.
// The transcript marker, spelled out here rather than imported: interceptor.js
// keeps it private, and a test that reproduces it independently also pins it.
const USER_REQUEST_OPEN_MARKER = "<USER_REQUEST>\n";

const LINEAR_ITERATIONS = 20;
const LINEAR_TRIALS = 3;
const LINEAR_BUDGET_MS = 400; // healthy ≈2ms here; 20× headroom for a slow runner
const LINEAR_MAX_RATIO = 40;
// Floors the divisor so a control too cheap to measure cannot manufacture a
// huge ratio out of timer granularity.
const MIN_CONTROL_MS = 0.05;

function timeCall(fn, input, iterations) {
  const started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    fn(input);
  }
  return Number(process.hrtime.bigint() - started) / 1e6;
}

// Best of N: a GC pause or a noisy neighbour can only make a run look slower,
// never faster, so the minimum is the least flaky statistic available here.
function bestOf(fn, input, iterations, trials) {
  let best = Infinity;
  for (let trial = 0; trial < trials; trial += 1) {
    best = Math.min(best, timeCall(fn, input, iterations));
  }
  return best;
}

function assertLinearCost(fn, hostile, control, label, options = {}) {
  const {
    iterations = LINEAR_ITERATIONS,
    trials = LINEAR_TRIALS,
    budgetMs = LINEAR_BUDGET_MS,
    maxRatio = LINEAR_MAX_RATIO,
  } = options;
  assert.equal(
    hostile.length,
    control.length,
    `${label}: the benign control must be the same length as the hostile input`,
  );
  timeCall(fn, control, 1); // warm the JIT on the cheap input only
  const controlMs = Math.max(bestOf(fn, control, iterations, trials), MIN_CONTROL_MS);
  const hostileMs = bestOf(fn, hostile, iterations, trials);
  const detail = `(${iterations}× ${hostile.length} chars: hostile ${hostileMs.toFixed(2)}ms, benign control ${controlMs.toFixed(2)}ms)`;
  assert.ok(
    hostileMs < budgetMs,
    `${label}: took ${hostileMs.toFixed(1)}ms, over the ${budgetMs}ms floor ${detail}`,
  );
  const ratio = hostileMs / controlMs;
  assert.ok(
    ratio < maxRatio,
    `${label}: cost ${ratio.toFixed(1)}× a same-length benign control, over the ${maxRatio}× bound ${detail}`,
  );
  return ratio;
}

// The pre-fix patterns, copied verbatim from the commit messages that removed
// them (ac0f356, 7f95753). interceptor.js is never modified; these exist only
// to prove the bound above is load-bearing rather than decorative — a guard
// that cannot be shown to fail against the original bug is not a guard.
const PRE_FIX_AUTHORIZATION = /(\bauthorization:\s*(?:bearer|basic)?\s+)([^\s"';&|]+)/gi;
const preFixRedactStringSecrets = (value) =>
  // Keeps the byte-cap shield and reverts only the pattern: the exact partial
  // regression the absolute floor exists for.
  value.slice(0, MAX_REDACT_STRING_BYTES).replace(PRE_FIX_AUTHORIZATION, "$1[REDACTED]");

const PRE_FIX_SHELL_READ =
  /\b(cat|head|tail|less|more|grep|find|ls|pwd|whoami|echo(?!\s.*>)|file|stat|wc|diff|which|type|env|printenv|date|uname)\b/i;
const preFixInferShellEffect = (command) =>
  PRE_FIX_SHELL_READ.test(command) ? "read" : "execute";

const PRE_FIX_MEMBER = /(^|_)(share|add_.*_member)(_|$)/i;
const preFixInferEffect = (name) => (PRE_FIX_MEMBER.test(name) ? "update" : "execute");

const PRE_FIX_USER_REQUEST = /<USER_REQUEST>\n([\s\S]*?)\n<\/USER_REQUEST>/;
const preFixExtractLastUserPrompt = (text) => {
  const match = PRE_FIX_USER_REQUEST.exec(text);
  return match ? match[1] : null;
};

// --- Subprocess helpers (R3, R5, R11, R12) ---------------------------------

async function waitUntil(predicate, timeoutMs = 10_000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

// FIFOs are how a *blocked* filesystem is simulated: an open(2) that never
// returns wedges a libuv threadpool thread, which is the exact hazard the
// config deadline (R5) and the audit deadline (R11) exist for. Every one of
// these runs in a child process — an in-process read of a FIFO cannot be
// reached by an AbortSignal, and `node --test` would never exit.
function makeFifoAt(file) {
  try {
    execFileSync("mkfifo", [file], { stdio: "ignore" });
    return file;
  } catch {
    return null; // no mkfifo (Windows, restricted image): the caller skips
  }
}

const makeFifo = (name) => makeFifoAt(tmpPath(name));

// Reads stdout while the child is still alive, then kills it. A process with a
// wedged threadpool thread cannot be joined — interceptor.js documents that
// neither process.exit(0) nor the watchdog can end it — so awaiting a normal
// exit would hang the suite. What survives that is whatever already reached
// stdout, which is the whole point of emitting the decision first.
function runUntilDecision({
  env = {},
  stdin = "",
  keepStdinOpen = false,
  until,
  timeoutMs = 12_000,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [INTERCEPTOR], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let decisionMs = null;
    let exited = false;
    let settled = false;

    const state = () => ({ stdout, stderr, decisionMs, exited, elapsedMs: Date.now() - started });
    const ready = () => {
      if (decisionMs === null) {
        return false;
      }
      return typeof until === "function" ? until(state()) : true;
    };
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (exited) {
        resolve(state());
        return;
      }
      child.once("close", () => resolve(state()));
      child.kill("SIGKILL");
    };
    const timer = setTimeout(finish, timeoutMs);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (decisionMs === null && safeJson(stdout)) {
        decisionMs = Date.now() - started;
      }
      if (ready()) {
        finish();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (ready()) {
        finish();
      }
    });
    child.stdin.on("error", () => {});
    child.on("error", () => finish());
    child.on("close", () => {
      exited = true;
      finish();
    });

    if (keepStdinOpen) {
      if (stdin) {
        child.stdin.write(stdin);
      }
    } else {
      child.stdin.end(stdin);
    }
  });
}

function runNodeEval(source, env = childEnv()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// R1 — ReDoS in redactStringSecrets
// ---------------------------------------------------------------------------

// `\s*(?:bearer|basic)?\s+` let two adjacent quantifiers match the same
// character: the two whitespace runs share every split point, so a long run of
// spaces that never completes the match backtracks quadratically. Measured on
// the unfixed build: 8.7ms at 4 KB, 43ms at 8 KB, 96ms at 16 KB, 517ms at 32 KB.
const REDACT_REDOS_SHAPES = [
  [
    "whitespace run after authorization:",
    (n) => `authorization:${" ".repeat(n)}`,
    (n) => `authorizationz${" ".repeat(n)}`,
  ],
  [
    "whitespace run terminated by an excluded character",
    (n) => `authorization:${" ".repeat(n)}"`,
    (n) => `authorizationz${" ".repeat(n)}"`,
  ],
  [
    "repeated authorization: blocks",
    (n) => "authorization: ".repeat(Math.floor(n / 15)),
    (n) => "authorizationz ".repeat(Math.floor(n / 15)),
  ],
  [
    "--token run",
    (n) => `--token ${" ".repeat(n)}`,
    (n) => `--tokenz${" ".repeat(n)}`,
  ],
  [
    "tab run after authorization:",
    (n) => `authorization:${"\t".repeat(n)}`,
    (n) => `authorizationz${"\t".repeat(n)}`,
  ],
];

test("R1: redactStringSecrets stays linear on every ReDoS-shaped secret string", () => {
  for (const [shape, hostile, control] of REDACT_REDOS_SHAPES) {
    // 8 KB is under MAX_REDACT_STRING_BYTES and 32/128 KB are over it, so the
    // pattern is measured both unshielded and behind the byte cap.
    for (const size of [8_192, 32_768, 131_072]) {
      assertLinearCost(
        redactStringSecrets,
        hostile(size),
        control(size),
        `R1 redactStringSecrets, ${shape} at ${size}B`,
      );
    }
  }
});

test("R1: redactStringSecrets still redacts the shapes the ReDoS inputs are built from", () => {
  // Linearity is worthless if it was bought by no longer matching.
  assert.equal(
    redactStringSecrets('curl -H "authorization: bearer abc123" https://x'),
    'curl -H "authorization: bearer [REDACTED]" https://x',
  );
  assert.equal(redactStringSecrets("authorization: abc123"), "authorization: [REDACTED]");
  assert.equal(redactStringSecrets("authorization:\tabc123"), "authorization:\t[REDACTED]");
  assert.equal(redactStringSecrets("deploy --token sk_1"), "deploy --token [REDACTED]");
  assert.equal(redactStringSecrets("TOKEN=sk_1 run"), "TOKEN=[REDACTED] run");
});

test("R1: the pre-fix authorization pattern would have failed the linearity bound", () => {
  // The probe that makes the guard meaningful. Budget disabled so only the
  // machine-independent ratio can fire — the half that has to hold on a shared
  // CI runner. (At the suite's 20 iterations the 400ms floor fires too: the
  // pre-fix pattern costs ~110ms per call at 16 KB even with the byte cap kept.)
  const size = MAX_REDACT_STRING_BYTES;
  assert.throws(
    () =>
      assertLinearCost(
        preFixRedactStringSecrets,
        `authorization:${" ".repeat(size)}`,
        `authorizationz${" ".repeat(size)}`,
        "R1 pre-fix probe",
        { iterations: 1, trials: 1, budgetMs: Infinity },
      ),
    /over the 40× bound/,
    "the pre-fix authorization pattern must fail the bound the fixed one passes",
  );
});

// ---------------------------------------------------------------------------
// R2 — MAX_REDACT_STRING_BYTES: a secret must not escape via truncate-before-scan
// ---------------------------------------------------------------------------

test("R2: no secret escapes through the MAX_REDACT_STRING_BYTES cut", () => {
  // Cutting before scanning is the second defence against R1, and it is only
  // safe if the cut cannot strand a secret on the far side of it. The secret is
  // swept across the boundary a byte at a time: at every offset it is either
  // redacted or gone, never passed through.
  const secret = "SUPERSECRETVALUE1234";
  const build = (startAt) => `${"f".repeat(startAt - 1)} authorization: ${secret} tail`;

  let redactedCount = 0;
  let cutCount = 0;
  for (let offset = -120; offset <= 40; offset += 1) {
    const input = build(MAX_REDACT_STRING_BYTES + offset);
    const output = redactStringSecrets(input);
    assert.equal(
      output.includes(secret),
      false,
      `secret survived at offset ${offset} (${JSON.stringify(output.slice(-70))})`,
    );
    // Not even a fragment: a partial secret is still a secret.
    assert.equal(
      output.includes(secret.slice(0, 4)),
      false,
      `a secret fragment survived at offset ${offset}`,
    );
    assert.ok(
      Buffer.byteLength(output, "utf-8") <= MAX_REDACT_STRING_BYTES,
      `output exceeded the cap at offset ${offset}`,
    );
    if (output.includes("[REDACTED]")) {
      redactedCount += 1;
    } else {
      cutCount += 1;
    }
  }
  // Both sides of the boundary were actually exercised.
  assert.ok(redactedCount > 10, `only ${redactedCount} offsets redacted in place`);
  assert.ok(cutCount > 10, `only ${cutCount} offsets were cut away`);

  // And the head that *survives* an oversized string is still scanned: the cut
  // happens before the scan, never instead of it. (A `write_to_file` body that
  // opens with a credential is the shape this protects.)
  const oversized = `authorization: ${secret} ${"f".repeat(MAX_REDACT_STRING_BYTES * 2)}`;
  const scanned = redactStringSecrets(oversized);
  assert.ok(Buffer.byteLength(scanned, "utf-8") <= MAX_REDACT_STRING_BYTES);
  assert.equal(scanned.includes(secret), false, "a secret in the kept head went unscanned");
  assert.match(scanned, /^authorization: \[REDACTED\] fff/);
});

test("R2: a multibyte character straddling the cut never corrupts the output", () => {
  // A naive byte cut here would emit a half character, and the emitted decision
  // (or the audit record) would stop being valid JSON.
  for (let pad = 0; pad < 8; pad += 1) {
    for (const char of ["é", "€", "😀"]) {
      const input = "a".repeat(pad) + char.repeat(9_000);
      const output = redactStringSecrets(input);
      const label = `pad=${pad} char=${char}`;
      assert.ok(
        Buffer.byteLength(output, "utf-8") <= MAX_REDACT_STRING_BYTES,
        `${label}: over the cap`,
      );
      assert.equal(output.includes("�"), false, `${label}: replacement character`);
      // No lone surrogate survives once the well-formed pairs are removed.
      assert.equal(
        /[\uD800-\uDFFF]/.test(output.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")),
        false,
        `${label}: lone surrogate`,
      );
      assert.equal(JSON.parse(JSON.stringify({ v: output })).v, output, `${label}: JSON round-trip`);
    }
  }
});

test("R2: a secret past the cut is dropped rather than smuggled into the preview", () => {
  const config = { ...TEST_CONFIG, maxContextBytes: 512 };
  const value = {
    CommandLine: `${"echo padding; ".repeat(2_000)} authorization: LEAKED_TOKEN_VALUE`,
  };
  const serialized = JSON.stringify(boundedContext(value, config));
  assert.equal(serialized.includes("LEAKED_TOKEN_VALUE"), false);
  assert.ok(Buffer.byteLength(serialized, "utf-8") < 2_000);
});

// ---------------------------------------------------------------------------
// R3 — Signals
// ---------------------------------------------------------------------------

const CATCHABLE_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];

test("R3: every catchable signal still ends in exit 0 and one decision", { timeout: 60000 }, async () => {
  // Signal death is a normal way for this process to end — the host kills the
  // child at its own timeout, Ctrl-C reaches the whole process group, closing
  // the IDE sends SIGHUP — and an unhandled signal bypasses the exit handler
  // entirely, leaving empty stdout and the outcome to the host.
  const combos = [];
  for (const signal of CATCHABLE_SIGNALS) {
    for (const failMode of ["open", "closed"]) {
      combos.push([signal, failMode]);
    }
  }

  await withServer(
    // A PDP that never answers: every child parks in fetch, so the signal
    // arrives while the decision is still outstanding.
    () => startStubServer(() => {}),
    async (server) => {
      const children = [];
      const runs = combos.map(([signal, failMode]) =>
        runInterceptor({
          stdin: JSON.stringify(capturedPayload()),
          env: childEnv({
            DENIED_URL: server.url,
            DENIED_API_KEY: "dn_test",
            DENIED_FAIL_MODE: failMode,
          }),
          onChild: (child) => children.push({ child, signal, failMode }),
        }),
      );

      // Handlers are installed at module load, before main() runs, so a request
      // on the wire proves the handler is already in place — killing on a timer
      // instead would race module load on a slow runner.
      const armed = await waitUntil(() => server.requests.length >= combos.length, 20_000);
      assert.ok(
        armed,
        `only ${server.requests.length}/${combos.length} children reached the PDP before the signal`,
      );

      for (const { child, signal } of children) {
        child.kill(signal);
      }

      const results = await Promise.all(runs);
      results.forEach((result, index) => {
        const [signal, failMode] = combos[index];
        const label = `R3 ${signal} failMode=${failMode}`;
        const decision = assertDecision(result, label);
        // Exit 0 with a decision, never death by signal: `signal` is null.
        assert.equal(result.signal, null, `${label}: died by signal ${result.signal}`);
        assert.equal(
          decision.decision,
          failMode === "closed" ? "deny" : "allow",
          `${label}: wrong fail-safe direction`,
        );
        assert.match(decision.reason, new RegExp(`Received ${signal}`), label);
        // Exactly one object: assertDecision's JSON.parse rejects a second one,
        // and the count below rejects a duplicate that happens to concatenate.
        assert.equal(
          result.stdout.split('{"decision"').length - 1,
          1,
          `${label}: stdout carried more than one decision object`,
        );
      });
    },
  );
});

test("R3: requiring the interceptor installs no signal handlers", { timeout: 30000 }, async () => {
  // Nothing may run on require: the module is imported by this very file, and a
  // handler installed at import time would also mean the process-level state
  // below is shared with whatever imported it. Asserted in a *fresh* process —
  // the test runner installs handlers of its own, so an in-process count
  // measures the runner rather than the module.
  const events = [
    ...CATCHABLE_SIGNALS,
    "SIGPIPE",
    "exit",
    "uncaughtException",
    "unhandledRejection",
  ];
  const source = `
    const before = ${JSON.stringify(events)}.map((e) => process.listenerCount(e));
    require(${JSON.stringify(INTERCEPTOR)});
    const after = ${JSON.stringify(events)}.map((e) => process.listenerCount(e));
    process.stdout.write(JSON.stringify({ before, after }));
  `;
  const result = await runNodeEval(source);
  assert.equal(result.code, 0, `require() failed: ${result.stderr}`);
  const { before, after } = JSON.parse(result.stdout);
  assert.deepEqual(
    after,
    before,
    `requiring interceptor.js changed listener counts for ${events.join("/")}`,
  );
  assert.deepEqual(after, events.map(() => 0));
});

// ---------------------------------------------------------------------------
// R4 — Reason cap and response cap
// ---------------------------------------------------------------------------

// A corporate proxy answers a blocked request with a whole HTML page, and an
// emitted object larger than the OS pipe buffer blocks the write forever on a
// host that reads stdout only after we exit.
function bigBodyServer(body, status) {
  return startStubServer((req, res) => {
    res.writeHead(status, { "Content-Type": "text/html" });
    res.end(body);
  });
}

test("R4: a 200 KB error body is capped at MAX_REASON_BYTES and still parses", { timeout: 30000 }, async () => {
  const page = `<html>${"E".repeat(200_000)}</html>`;
  await withServer(
    () => bigBodyServer(page, 502),
    async (server) => {
      const result = await runInterceptor({
        stdin: JSON.stringify(capturedPayload()),
        env: childEnv({
          DENIED_URL: server.url,
          DENIED_API_KEY: "dn_test",
          DENIED_FAIL_MODE: "open",
        }),
      });

      const decision = assertDecision(result, "R4 reason cap");
      assert.equal(decision.decision, "allow");
      assert.ok(
        Buffer.byteLength(decision.reason, "utf-8") <= MAX_REASON_BYTES,
        `reason was ${Buffer.byteLength(decision.reason, "utf-8")} bytes`,
      );
      // stdout stays inside a pipe buffer with room to spare.
      assert.ok(result.stdout.length < MAX_REASON_BYTES + 512, `stdout was ${result.stdout.length} bytes`);
      // The head — the part that tells the agent why — is preserved.
      assert.match(decision.reason, /^Denied policy engine unavailable and fail-mode is open\. HTTP 502: <html>EEE/);
      // And the cut is visible rather than silent.
      assert.match(decision.reason, / … \[truncated \d+ bytes\]$/);
    },
  );
});

test("R4: a multibyte reason is cut on a character boundary and still parses", { timeout: 30000 }, async () => {
  // A naive byte cut would emit half a character and the decision would stop
  // being JSON — which denies on this platform.
  await withServer(
    () => bigBodyServer("😀".repeat(60_000), 503),
    async (server) => {
      const result = await runInterceptor({
        stdin: JSON.stringify(capturedPayload()),
        env: childEnv({
          DENIED_URL: server.url,
          DENIED_API_KEY: "dn_test",
          DENIED_FAIL_MODE: "closed",
        }),
      });

      const decision = assertDecision(result, "R4 multibyte reason");
      assert.equal(decision.decision, "deny");
      assert.ok(Buffer.byteLength(decision.reason, "utf-8") <= MAX_REASON_BYTES);
      assert.equal(decision.reason.includes("�"), false, "replacement character in the reason");
      assert.equal(
        /[\uD800-\uDFFF]/.test(decision.reason.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")),
        false,
        "lone surrogate in the reason",
      );
      assert.match(decision.reason, /😀/);
    },
  );
});

test("R4: a response over MAX_RESPONSE_BYTES routes through failMode", { timeout: 30000 }, async () => {
  // An unbounded res.json() on a large body is an out-of-memory abort (SIGABRT,
  // uncatchable, empty stdout). Overflow is reported instead of truncated: a
  // cut JSON body is not the PDP's answer, so even a leading `"decision":true`
  // must not be honoured.
  const oversized = JSON.stringify({
    decision: true,
    padding: "p".repeat(MAX_RESPONSE_BYTES + 200_000),
  });
  assert.ok(Buffer.byteLength(oversized, "utf-8") > MAX_RESPONSE_BYTES);

  await withServer(
    () =>
      startStubServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(oversized);
      }),
    async (server) => {
      const [open, closed] = await Promise.all([
        runInterceptor({
          stdin: JSON.stringify(capturedPayload()),
          env: childEnv({
            DENIED_URL: server.url,
            DENIED_API_KEY: "dn_test",
            DENIED_FAIL_MODE: "open",
          }),
        }),
        runInterceptor({
          stdin: JSON.stringify(capturedPayload()),
          env: childEnv({
            DENIED_URL: server.url,
            DENIED_API_KEY: "dn_test",
            DENIED_FAIL_MODE: "closed",
          }),
        }),
      ]);

      assert.equal(assertDecision(open, "R4 overflow open").decision, "allow");
      assert.equal(assertDecision(closed, "R4 overflow closed").decision, "deny");
      for (const result of [open, closed]) {
        assert.match(result.stderr, new RegExp(`response exceeded ${MAX_RESPONSE_BYTES} bytes`));
        assert.ok(result.durationMs < WATCHDOG_MS, `took ${result.durationMs}ms`);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// R5 — Config deadline and config/stdin concurrency
// ---------------------------------------------------------------------------

test("R5: a config file that never resolves decides at its own deadline, not the watchdog", { timeout: 40000 }, async () => {
  const fifo = makeFifo("stalled-config.fifo");
  if (!fifo) {
    return; // no FIFOs on this platform
  }
  const url = await closedPortUrl();

  const stalled = await runUntilDecision({
    stdin: JSON.stringify(capturedPayload()),
    env: childEnv({ DENIED_CONFIG: fifo, DENIED_URL: url, DENIED_API_KEY: "dn_test" }),
    until: (state) => /timed out/.test(state.stderr),
  });

  assert.notEqual(stalled.decisionMs, null, `no decision on stdout: ${stalled.stderr}`);
  const decision = JSON.parse(stalled.stdout);
  assert.ok(
    stalled.decisionMs >= DEFAULT_CONFIG_TIMEOUT_MS - 200,
    `decided before the config deadline (${stalled.decisionMs}ms)`,
  );
  assert.ok(
    stalled.decisionMs < WATCHDOG_MS - 1_000,
    `the watchdog decided this, not the config deadline (${stalled.decisionMs}ms)`,
  );
  // "Your settings exist and did not arrive" is a different situation from "you
  // have no settings", and only the first one warns.
  assert.match(
    stalled.stderr,
    new RegExp(`Config read at .* timed out after ${DEFAULT_CONFIG_TIMEOUT_MS}ms`),
  );
  assert.match(stalled.stderr, /failMode may not be yours/);
  // The documented residual, pinned so a future silent change is caught: an
  // unresolvable config decides on the built-in default, which is `open`. A
  // `failMode: closed` sitting unread in that file does not apply.
  assert.equal(decision.decision, "allow");
  assert.match(decision.reason, /fail-mode is open/);

  // The control: a config file that is merely absent stays quiet.
  const absent = await runInterceptor({
    stdin: JSON.stringify(capturedPayload()),
    env: childEnv({ DENIED_URL: url, DENIED_API_KEY: "dn_test" }),
  });
  assert.equal(assertDecision(absent, "R5 absent config").decision, "allow");
  assert.equal(/timed out/.test(absent.stderr), false, absent.stderr);
  assert.ok(absent.durationMs < DEFAULT_CONFIG_TIMEOUT_MS, `took ${absent.durationMs}ms`);
});

test("R5: the config read and the stdin read run concurrently", { timeout: 40000 }, async () => {
  // Sequenced, a stalled config file would spend the stdin budget as well and
  // push the decision into the watchdog. Timing is the only way to see it:
  // concurrent ≈ max(1000, 2000) = 2000ms, serialized ≈ 3000ms.
  const fifo = makeFifo("concurrent-config.fifo");
  if (!fifo) {
    return;
  }
  await withServer(
    () => jsonServer(ALLOW_BODY),
    async (server) => {
      const result = await runUntilDecision({
        keepStdinOpen: true, // the host may never close the pipe
        env: childEnv({ DENIED_CONFIG: fifo, DENIED_URL: server.url, DENIED_API_KEY: "dn_test" }),
      });

      assert.notEqual(result.decisionMs, null, `no decision on stdout: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).decision, "allow");
      assert.ok(
        result.decisionMs >= DEFAULT_STDIN_TIMEOUT_MS - 300,
        `decided before the stdin deadline (${result.decisionMs}ms)`,
      );
      assert.ok(
        // Halfway between the concurrent and the serialized cost, expressed in
        // the constants so it tracks a change to either deadline.
        result.decisionMs < DEFAULT_STDIN_TIMEOUT_MS + DEFAULT_CONFIG_TIMEOUT_MS * 0.6,
        `the config read and the stdin read were serialized (${result.decisionMs}ms; concurrent ≈ ${DEFAULT_STDIN_TIMEOUT_MS}ms, serialized ≈ ${DEFAULT_STDIN_TIMEOUT_MS + DEFAULT_CONFIG_TIMEOUT_MS}ms)`,
      );
      assert.equal(server.requests.length, 1);
    },
  );
});

// ---------------------------------------------------------------------------
// R6 — Blank and invalid failMode values
// ---------------------------------------------------------------------------

test("R6: a blank failMode warns instead of silently falling back to open", () => {
  // "Present but blank" is not absence: `""` and `"   "` are strings a user
  // typed or a template rendered empty, and on a platform where the config file
  // is the only practical mechanism they would otherwise land silently on the
  // permissive side.
  for (const blank of ["", "   "]) {
    const envWarnings = [];
    const envCfg = resolveConfig({ DENIED_FAIL_MODE: blank }, {}, (m) => envWarnings.push(m));
    assert.equal(envCfg.failMode, "open");
    assert.deepEqual(envWarnings, [
      'Ignoring blank DENIED_FAIL_MODE; falling back to the config file or "open".',
    ]);

    const fileWarnings = [];
    const fileCfg = resolveConfig({}, { failMode: blank }, (m) => fileWarnings.push(m));
    assert.equal(fileCfg.failMode, "open");
    assert.deepEqual(fileWarnings, [
      'Ignoring blank failMode in the config file; falling back to "open".',
    ]);
  }
});

test("R6: a blank DENIED_FAIL_MODE still lets the config file decide", () => {
  const warnings = [];
  const cfg = resolveConfig({ DENIED_FAIL_MODE: "" }, { failMode: "closed" }, (m) => warnings.push(m));
  assert.equal(cfg.failMode, "closed");
  assert.equal(warnings.length, 1);
});

// A whitespace-only env var is truthy, so it would win over a valid config
// value and then fail every fetch — a silent fail-open under the default
// failMode, from the same class as the blank-failMode finding.
test("R6: a whitespace-only DENIED_URL/DENIED_API_KEY warns and defers to the file", () => {
  const warnings = [];
  const cfg = resolveConfig(
    { DENIED_URL: "   ", DENIED_API_KEY: "  " },
    { url: "https://internal.pdp", apiKey: "dn_real" },
    (m) => warnings.push(m),
    "/home/dev",
  );
  assert.equal(cfg.url, "https://internal.pdp");
  assert.equal(cfg.apiKey, "dn_real");
  assert.deepEqual(warnings, [
    "Ignoring blank DENIED_URL; falling back to the config file value.",
    "Ignoring blank DENIED_API_KEY; falling back to the config file value.",
  ]);
});

test("R6: empty and valid DENIED_URL values are unaffected by the blank check", () => {
  const emptyWarnings = [];
  const empty = resolveConfig(
    { DENIED_URL: "" },
    { url: "https://internal.pdp" },
    (m) => emptyWarnings.push(m),
    "/home/dev",
  );
  assert.equal(empty.url, "https://internal.pdp");
  assert.deepEqual(emptyWarnings, []);

  const setWarnings = [];
  const set = resolveConfig(
    { DENIED_URL: "https://env.pdp" },
    { url: "https://file.pdp" },
    (m) => setWarnings.push(m),
    "/home/dev",
  );
  assert.equal(set.url, "https://env.pdp");
  assert.deepEqual(setWarnings, []);
});

test("R6: a non-string failMode warns with its type and falls back to open", () => {
  for (const [value, described] of [
    [true, "boolean"],
    [["closed"], "array"],
    [null, "null"],
    [0, "number"],
    [{ mode: "closed" }, "object"],
  ]) {
    const warnings = [];
    const cfg = resolveConfig({}, { failMode: value }, (m) => warnings.push(m));
    assert.equal(cfg.failMode, "open", JSON.stringify(value));
    assert.deepEqual(
      warnings,
      [`Ignoring non-string failMode (${described}) in the config file; falling back to "open".`],
      JSON.stringify(value),
    );
  }
});

test("R6: an absent failMode reaches the default in silence", () => {
  // Absence is the only thing allowed through quietly.
  const warnings = [];
  assert.equal(resolveConfig({}, {}, (m) => warnings.push(m)).failMode, "open");
  assert.equal(resolveConfig({}, { url: "https://x" }, (m) => warnings.push(m)).failMode, "open");
  assert.equal(
    resolveConfig({ DENIED_URL: "https://x" }, {}, (m) => warnings.push(m)).failMode,
    "open",
  );
  assert.deepEqual(warnings, []);
});

test("R6: a blank failMode is reported on stderr end to end", { timeout: 30000 }, async () => {
  const configPath = await writeJson(tmpPath("r6-blank-config.json"), {
    apiKey: "dn_file",
    failMode: "   ",
  });
  await withServer(
    () => jsonServer(ALLOW_BODY),
    async (server) => {
      const result = await runInterceptor({
        stdin: JSON.stringify(capturedPayload()),
        env: childEnv({ DENIED_CONFIG: configPath, DENIED_URL: server.url }),
      });
      assert.equal(assertDecision(result, "R6 blank failMode").decision, "allow");
      assert.match(result.stderr, /Ignoring blank failMode in the config file/);
    },
  );
});

// ---------------------------------------------------------------------------
// R7 — Emission tracked by delivery, not by intent
// ---------------------------------------------------------------------------

test("R7: a throwing writer leaves the emission unclaimed so the exit net stays armed", () => {
  // The writer records a partial delivery itself, so a writer that threw
  // without delivering anything means nothing reached stdout — and the exit net
  // still owes a whole object. Marking the emission done here would leave
  // stdout empty and the outcome to the host.
  resetEmitState();
  try {
    assert.throws(
      () =>
        emitDecision("deny", "nope", () => {
          throw new Error("stdout is gone");
        }),
      /stdout is gone/,
    );
    assert.equal(hasEmitted(), false, "a failed write must not count as an emission");

    // ...and the retry the exit net would make still produces one whole object.
    const written = [];
    assert.equal(emitDecision("deny", "nope", (text) => written.push(text)), true);
    assert.equal(hasEmitted(), true);
    assert.deepEqual(written, ['{"decision":"deny","reason":"nope"}']);
  } finally {
    resetEmitState();
  }
});

test("R7: a re-entrant emit is still suppressed while the first is on the stack", () => {
  // A second complete object after the first is exactly as unparseable as a
  // fragment, so the guard has to hold while a writer is mid-flight — not only
  // after it returns.
  resetEmitState();
  try {
    const written = [];
    const reentrant = (text) => {
      written.push(text);
      assert.equal(
        emitDecision("deny", "late", (nested) => written.push(nested)),
        false,
        "a re-entrant emit must be suppressed",
      );
    };
    assert.equal(emitDecision("allow", "", reentrant), true);
    assert.deepEqual(written, ['{"decision":"allow"}']);
    assert.equal(hasEmitted(), true);
  } finally {
    resetEmitState();
  }
});

// ---------------------------------------------------------------------------
// R8 — Linearity of the effect tables and the transcript scan
// ---------------------------------------------------------------------------

test("R8: inferShellEffect stays linear on echo/redirect ReDoS shapes", () => {
  // `echo(?!\s.*>)` guarded the "read" classification, and its unanchored
  // greedy `.*` was re-evaluated to end-of-string at *every* `echo`: 156ms at
  // 80 KB, 621ms at 160 KB, 2.5s at 320 KB, 26s at 1 MB on the unfixed build —
  // all synchronous, so the host's timeout decided the tool call instead of us.
  for (const size of [80_000, 320_000, 1_000_000]) {
    const units = Math.floor(size / 5);
    assertLinearCost(
      inferShellEffect,
      `${"echo ".repeat(units)}>`,
      `${"zcho ".repeat(units)}>`,
      `R8 inferShellEffect, echo run with a trailing redirect at ${size}B`,
    );
    assertLinearCost(
      inferShellEffect,
      "echo ".repeat(units),
      "zcho ".repeat(units),
      `R8 inferShellEffect, echo run with no redirect at ${size}B`,
    );
  }
});

test("R8: inferEffect stays linear on add_*_member tool-name shapes", () => {
  // The second copy of the same bug, and the one a reviewer cleared by
  // inspection: `(^|_)` restarts the match at every underscore, and at every
  // one that begins `add_` the greedy `.*` ran to end-of-string and backtracked.
  // 7ms at 8 KB, 98ms at 32 KB, 1.56s at 128 KB on the unfixed build — on a
  // string that arrives straight from the payload as `resource.id`.
  const byName = (name) => inferEffect(name, {});
  for (const size of [8_192, 32_768, 131_072]) {
    const units = Math.floor(size / 4);
    assertLinearCost(
      byName,
      "add_".repeat(units),
      "zdd_".repeat(units),
      `R8 inferEffect, add_ run at ${size}B`,
    );
  }
  for (const size of [8_192, 32_768]) {
    const units = Math.floor(size / 6);
    assertLinearCost(
      byName,
      "add_x_".repeat(units),
      "zdd_x_".repeat(units),
      `R8 inferEffect, add_<segment>_ run at ${size}B`,
    );
  }
});

test("R8: the effect tables still classify the shapes those inputs are built from", () => {
  // Linearity bought by no longer matching would be no fix at all.
  assert.equal(inferShellEffect("echo hi"), "read");
  assert.equal(inferShellEffect("echo hi > out.txt"), "create");
  assert.equal(inferEffect("add_project_member", {}), "update");
  assert.equal(inferEffect("share_document", {}), "update");
  // Documented cost of the `[^_]*` bound: a multi-segment role no longer
  // matches the member pattern and falls through to `add` → create. The tool
  // name itself still reaches the PDP verbatim, and the effect is advisory.
  assert.equal(inferEffect("add_org_team_member", {}), "create");
});

test("R8: extractLastUserPrompt stays linear on unclosed USER_REQUEST markers", () => {
  // `/<USER_REQUEST>\n([\s\S]*?)\n<\/USER_REQUEST>/` is quadratic in the number
  // of *unclosed* opening markers in one record: 43ms at 5,000 markers, 173ms
  // at 10,000, 695ms at 20,000. DEFAULT_TAIL_BYTES capped the window at 64 KB,
  // so it was not reachable — but the window was the only thing holding the
  // line, and a larger tail is one config change away.
  for (const markers of [2_500, 10_000, 20_000]) {
    const hostileContent = USER_REQUEST_OPEN_MARKER.repeat(markers);
    const hostile = `${JSON.stringify({ type: "USER_INPUT", content: hostileContent })}\n`;
    const control = `${JSON.stringify({
      type: "USER_INPUT",
      content: hostileContent.replace(/[<>]/g, "z"),
    })}\n`;
    assertLinearCost(
      extractLastUserPrompt,
      hostile,
      control,
      `R8 extractLastUserPrompt, ${markers} unclosed markers`,
    );
  }
});

test("R8: extractLastUserPrompt still fails short rather than open on a nested marker", () => {
  // Semantics pinned alongside the linearity: the first opening marker, then
  // the earliest closing marker after it.
  const content = `${USER_REQUEST_OPEN_MARKER}run whoami\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nx\n</USER_SETTINGS_CHANGE>`;
  const line = JSON.stringify({ type: "USER_INPUT", content });
  assert.equal(extractLastUserPrompt(`${line}\n`), "run whoami");
  const unclosed = JSON.stringify({
    type: "USER_INPUT",
    content: USER_REQUEST_OPEN_MARKER.repeat(3),
  });
  assert.equal(
    extractLastUserPrompt(`${unclosed}\n`),
    USER_REQUEST_OPEN_MARKER.repeat(3),
  );
});

test("R8: the pre-fix shell, tool-name and transcript patterns would have failed the bound", () => {
  // The probes that make the three R8 guards meaningful. Budget disabled so
  // only the machine-independent ratio can fire; sizes chosen so a single
  // pre-fix call costs ~100–200ms rather than the seconds the full-size inputs
  // would take.
  const shellUnits = 80_000 / 5;
  assert.throws(
    () =>
      assertLinearCost(
        preFixInferShellEffect,
        `${"echo ".repeat(shellUnits)}>`,
        `${"zcho ".repeat(shellUnits)}>`,
        "R8 pre-fix shell probe",
        { iterations: 1, trials: 1, budgetMs: Infinity },
      ),
    /over the 40× bound/,
    "the pre-fix echo lookahead must fail the bound the fixed table passes",
  );

  const nameUnits = 32_768 / 4;
  assert.throws(
    () =>
      assertLinearCost(
        preFixInferEffect,
        "add_".repeat(nameUnits),
        "zdd_".repeat(nameUnits),
        "R8 pre-fix tool-name probe",
        { iterations: 1, trials: 1, budgetMs: Infinity },
      ),
    /over the 40× bound/,
    "the pre-fix add_.*_member pattern must fail the bound the fixed table passes",
  );

  const markers = 10_000;
  const hostileContent = USER_REQUEST_OPEN_MARKER.repeat(markers);
  assert.throws(
    () =>
      assertLinearCost(
        preFixExtractLastUserPrompt,
        hostileContent,
        hostileContent.replace(/[<>]/g, "z"),
        "R8 pre-fix transcript probe",
        { iterations: 1, trials: 1, budgetMs: Infinity },
      ),
    /over the 40× bound/,
    "the pre-fix USER_REQUEST regex must fail the bound the fixed scan passes",
  );
});

// ---------------------------------------------------------------------------
// R9 — MAX_TOOL_NAME_BYTES
// ---------------------------------------------------------------------------

test("R9: an oversized tool name is truncated with a visible marker", () => {
  // A megabyte-long "tool name" is not a tool name: it reaches the PDP as
  // resource.id and is run through every NAME_EFFECT_PATTERN on the way.
  const name = "T".repeat(8_000);
  const { name: bounded } = normalizeToolCall({ toolCall: { name } });
  assert.ok(
    Buffer.byteLength(bounded, "utf-8") <= MAX_TOOL_NAME_BYTES,
    `tool name was ${Buffer.byteLength(bounded, "utf-8")} bytes`,
  );
  assert.match(bounded, /^TTTT/);
  assert.match(bounded, / … \[truncated 8000 bytes\]$/);

  // A name at the boundary is left exactly as it arrived.
  const exact = "n".repeat(MAX_TOOL_NAME_BYTES);
  assert.equal(normalizeToolCall({ toolCall: { name: exact } }).name, exact);
});

test("R9: the bounded tool name is what reaches the PDP", { timeout: 30000 }, async () => {
  const name = "T".repeat(8_000);
  const body = buildCheckBody({ toolCall: { name } }, TEST_CONFIG);
  assert.equal(body.resource.id, body.action.properties.tool_name);
  assert.ok(Buffer.byteLength(body.resource.id, "utf-8") <= MAX_TOOL_NAME_BYTES);

  await withServer(
    () => jsonServer(ALLOW_BODY),
    async (server) => {
      const result = await runInterceptor({
        stdin: JSON.stringify(capturedPayload({ toolCall: { name, args: { Cwd: "/w" } } })),
        env: childEnv({ DENIED_URL: server.url, DENIED_API_KEY: "dn_test" }),
      });

      assert.equal(assertDecision(result, "R9").decision, "allow");
      assert.equal(server.requests.length, 1);
      const sent = server.requests[0].json;
      // Bounded, but still delivered: the check is never skipped over a name.
      assert.ok(Buffer.byteLength(sent.resource.id, "utf-8") <= MAX_TOOL_NAME_BYTES);
      assert.match(sent.resource.id, / … \[truncated 8000 bytes\]$/);
      assert.equal(sent.action.properties.tool_name, sent.resource.id);
    },
  );
});

// ---------------------------------------------------------------------------
// R10 — MAX_STDIN_BYTES and repairTruncatedJson
// ---------------------------------------------------------------------------

test("R10: repairTruncatedJson rebuilds a parseable object from every cut shape", () => {
  // Dropping an oversized payload throws away the two fields policy needs most
  // (resource.id and subject.id), and they are exactly the fields a caller
  // cannot move past the cut.
  const table = [
    ['{"a":"hello wor', { a: "hello wor" }, "cut mid string value"],
    ['{"a":1,"bcd', { a: 1 }, "cut mid key — rewind, a closed string cannot precede }"],
    ['{"a":1,', { a: 1 }, "dangling comma — the safe point sits before it"],
    ['{"a":[1,2,', { a: [1, 2] }, "dangling comma inside an array"],
    ['{"a":"x\\u12', { a: "x" }, "cut inside a \\uXXXX escape"],
    ['{"a":"x\\', { a: "x" }, "cut on a trailing backslash"],
    [
      '{"a":{"b":[1,2,{"c":"de',
      { a: { b: [1, 2, { c: "de" }] } },
      "nested containers all closed in order",
    ],
    ['{"a":1}', { a: 1 }, "an already complete document is returned as-is"],
    ["{", {}, "nothing but an opening brace still parses"],
    ['{"a":1,"b":{', { a: 1, b: {} }, "an empty nested container closes"],
  ];
  for (const [input, expected, why] of table) {
    const repaired = repairTruncatedJson(input);
    assert.deepEqual(repaired, expected, `${why}: ${input}`);
    // A repair that does not parse is not a repair.
    assert.deepEqual(JSON.parse(JSON.stringify(repaired)), expected, why);
  }
});

test("R10: repairTruncatedJson returns null rather than guessing", () => {
  for (const input of ["", "xyz", "[1,2", "[1,2]", "null", "42", '"str', null, undefined, 7]) {
    assert.equal(repairTruncatedJson(input), null, JSON.stringify(input));
  }
});

test("R10: repairTruncatedJson never throws on any prefix of a real payload", () => {
  // The cut lands wherever the ceiling falls, so every offset is reachable.
  const document = JSON.stringify(
    capturedPayload({
      toolCall: {
        name: "write_to_file",
        args: {
          TargetFile: "/w/p/big.txt",
          CodeContent: 'line one\n"quoted"\\ é 😀 tail',
          Nested: { list: [1, 2, { deep: "value" }], flag: true, empty: {} },
        },
      },
    }),
  );
  let recovered = 0;
  for (let cut = 1; cut <= document.length; cut += 1) {
    const repaired = repairTruncatedJson(document.slice(0, cut));
    if (repaired === null) {
      continue;
    }
    assert.ok(
      repaired && typeof repaired === "object" && !Array.isArray(repaired),
      `offset ${cut} produced a non-object`,
    );
    // Parse-verified, exactly as the repair path promises.
    JSON.parse(JSON.stringify(repaired));
    recovered += 1;
  }
  assert.ok(recovered > document.length * 0.9, `only ${recovered}/${document.length} offsets recovered`);
  // The fields policy needs most survive a cut anywhere past them.
  const past = document.indexOf('"CodeContent"') + 20;
  const repaired = repairTruncatedJson(document.slice(0, past));
  assert.equal(repaired.toolCall.name, "write_to_file");
  assert.equal(repaired.conversationId, "435c93dd-d1ea-4fac-988d-c8e1eb9f5c76");
});

test("R10: an oversized stdin payload still sends the check, marked degraded", { timeout: 40000 }, async () => {
  // Time alone bounded stdin until this cap existed: everything that arrived
  // inside the deadline was buffered, stringified ~4x and deep-copied twice on
  // the synchronous decision path. Exceeding the cap must never cancel the
  // check — the deny the PDP would have given would be replaced by failMode.
  const oversized = JSON.stringify({
    ...capturedPayload({ conversationId: "conv-oversized" }),
    toolCall: {
      name: "write_to_file",
      args: {
        TargetFile: "/w/p/big.txt",
        CodeContent: "x".repeat(MAX_STDIN_BYTES + 512 * 1024),
      },
    },
  });
  assert.ok(Buffer.byteLength(oversized, "utf-8") > MAX_STDIN_BYTES);

  await withServer(
    () => jsonServer({ decision: false, context: { reason: "policy says no" } }),
    async (server) => {
      const result = await runInterceptor({
        stdin: oversized,
        env: childEnv({ DENIED_URL: server.url, DENIED_API_KEY: "dn_test" }),
      });

      const decision = assertDecision(result, "R10 oversized stdin");
      assert.equal(decision.decision, "deny");
      assert.equal(decision.reason, "policy says no");
      assert.ok(result.durationMs < WATCHDOG_MS, `took ${result.durationMs}ms`);

      assert.equal(server.requests.length, 1);
      const sent = server.requests[0].json;
      // The two fields policy needs most survived the cut.
      assert.equal(sent.resource.id, "write_to_file");
      assert.equal(sent.subject.id, "conv-oversized");
      // And the PDP is told it is judging a cut payload.
      assert.equal(sent.context.stdin_truncated, true);
      assert.equal(sent.context.stdin_bytes_read, MAX_STDIN_BYTES);
      assert.equal(sent.context.stdin_max_bytes, MAX_STDIN_BYTES);
      assert.equal(sent.context.payload_fidelity, "repaired");
      assert.match(result.stderr, new RegExp(`exceeded ${MAX_STDIN_BYTES} bytes`));
      assert.match(result.stderr, /repaired payload/);
    },
  );
});

test("R10: a normal payload carries no stdin-truncation context keys at all", { timeout: 30000 }, async () => {
  // The absence is load-bearing: buildCheckBody's full-body deepEqual test
  // would pass just as happily with these keys always present, and a policy
  // that keys off `stdin_truncated` would then see every payload as degraded.
  const body = buildCheckBody(capturedPayload(), TEST_CONFIG);
  for (const key of [
    "stdin_truncated",
    "stdin_bytes_read",
    "stdin_max_bytes",
    "payload_fidelity",
  ]) {
    assert.equal(key in body.context, false, `${key} must be absent on a normal payload`);
  }

  await withServer(
    () => jsonServer(ALLOW_BODY),
    async (server) => {
      const result = await runInterceptor({
        stdin: JSON.stringify(capturedPayload()),
        env: childEnv({ DENIED_URL: server.url, DENIED_API_KEY: "dn_test" }),
      });
      assert.equal(assertDecision(result, "R10 normal payload").decision, "allow");
      const context = server.requests[0].json.context;
      for (const key of [
        "stdin_truncated",
        "stdin_bytes_read",
        "stdin_max_bytes",
        "payload_fidelity",
      ]) {
        assert.equal(key in context, false, `${key} reached the PDP on a normal payload`);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// R11 (H14) — a wedged audit sink must not replace a real decision
// ---------------------------------------------------------------------------

test("R11 (H14): a wedged audit sink cannot replace a real deny", { timeout: 40000 }, async () => {
  // Audit is observability, never a gate on the decision — and "never a gate"
  // has to include *time*. The audit used to be awaited ahead of the emit, so
  // on a wedged sink the watchdog fired and a real deny became the failMode
  // outcome: silently an *allow* under the default failMode: open.
  //
  // The child does not exit afterwards, and cannot: a libuv threadpool thread
  // blocked in open(2) cannot be joined, so neither process.exit(0) nor the
  // watchdog can end it. That is a known platform limitation, and it is exactly
  // why the decision has to be on stdout before the audit is attempted.
  const auditDir = await tmpDir("r11-audit");
  const fifo = makeFifoAt(path.join(auditDir, "denied-antigravity-hook.jsonl"));
  if (!fifo) {
    return;
  }
  const configPath = await writeJson(tmpPath("r11-config.json"), {
    apiKey: "dn_file",
    audit: { enabled: true, dir: auditDir },
  });

  // The same run against a sink that works, as a baseline: both children pay
  // the same startup, config and PDP cost, so the difference between them is
  // the audit and nothing else. That is what makes the timing assertion below
  // machine-independent — an audit awaited *before* the emit would push the
  // wedged run a full audit deadline past this baseline.
  const workingDir = await tmpDir("r11-audit-ok");
  const workingConfig = await writeJson(tmpPath("r11-config-ok.json"), {
    apiKey: "dn_file",
    audit: { enabled: true, dir: workingDir },
  });

  await withServer(
    () => jsonServer({ decision: false, context: { reason: "policy says no" } }),
    async (server) => {
      const baseline = await runUntilDecision({
        stdin: JSON.stringify(capturedPayload()),
        env: childEnv({ DENIED_CONFIG: workingConfig, DENIED_URL: server.url }),
        // decisionMs is stamped when the decision lands, but this child is left
        // to exit on its own so its audit record actually gets written.
        until: (state) => state.exited,
      });
      assert.notEqual(baseline.decisionMs, null, `no baseline decision: ${baseline.stderr}`);

      const result = await runUntilDecision({
        stdin: JSON.stringify(capturedPayload()),
        env: childEnv({ DENIED_CONFIG: configPath, DENIED_URL: server.url }),
        until: (state) => /abandoning the record/.test(state.stderr),
      });

      assert.notEqual(result.decisionMs, null, `no decision on stdout: ${result.stderr}`);
      // The decision goes out *before* the audit is attempted, so a sink that
      // never accepts anything costs the decision nothing.
      assert.ok(
        result.decisionMs <= baseline.decisionMs + DEFAULT_AUDIT_TIMEOUT_MS * 0.6,
        `the decision waited on the audit sink (${result.decisionMs}ms vs a ${baseline.decisionMs}ms baseline; an audit awaited before the emit costs ${DEFAULT_AUDIT_TIMEOUT_MS}ms)`,
      );
      const decision = JSON.parse(result.stdout);
      // The PDP's real answer, not a fail-safe.
      assert.equal(decision.decision, "deny");
      assert.equal(decision.reason, "policy says no");
      assert.equal(result.stdout, '{"decision":"deny","reason":"policy says no"}');
      // Promptly: measured ~125ms, and far below the watchdog that used to
      // decide this.
      assert.ok(
        result.decisionMs < 3_000,
        `the decision waited on the audit sink (${result.decisionMs}ms)`,
      );
      assert.ok(result.decisionMs < WATCHDOG_MS, `${result.decisionMs}ms`);
      assert.match(
        result.stderr,
        new RegExp(`Audit write did not complete within ${DEFAULT_AUDIT_TIMEOUT_MS}ms`),
      );
      assert.match(result.stderr, /abandoning the record rather than delaying the decision/);
      assert.equal(server.requests.length, 2); // the baseline child and this one
      // The baseline's record did land, so the wedged run is the only variable.
      const written = await fs.readFile(
        path.join(workingDir, "denied-antigravity-hook.jsonl"),
        "utf-8",
      );
      assert.equal(written.trim().split("\n").length, 1);
    },
  );
});

// ---------------------------------------------------------------------------
// R12 (H15) — short-write integrity
// ---------------------------------------------------------------------------

// writeAllSync / writeStdout are not exported (they are the process's own I/O
// path, not library functions), so a short write can only be forced end to end:
// a `-r` preload patches require("node:fs").writeSync before interceptor.js
// destructures it, accepts N bytes on the first stdout write, and then fails.
function shortWritePreload({ accept = 5, failures = 1, killStdoutStream = true }) {
  return `
const fs = require("node:fs");
const realWriteSync = fs.writeSync;
let stdoutCalls = 0;
fs.writeSync = function (fd, ...rest) {
  if (fd !== 1) {
    return realWriteSync.call(fs, fd, ...rest);
  }
  stdoutCalls += 1;
  if (stdoutCalls === 1) {
    const [buffer, offset, length] = rest;
    const partial = Math.min(${accept}, length);
    realWriteSync.call(fs, fd, buffer, offset, partial);
    return partial; // a short write: the caller owns the remainder
  }
  if (stdoutCalls <= 1 + ${failures}) {
    const err = new Error("denied-test-forced-write-failure");
    err.code = "EIO"; // non-retryable, so writeAllSync returns short
    throw err;
  }
  return realWriteSync.call(fs, fd, ...rest);
};
${
  killStdoutStream
    ? 'process.stdout.write = () => { throw new Error("denied-test-dead-stdout-stream"); };\n'
    : ""
}
`;
}

test("R12 (H15): a short write is finished by the async flush, never duplicated", { timeout: 30000 }, async () => {
  // A short write used to set the "already emitted" flag while the remainder
  // was still unwritten, so an exit before the flush landed left a *fragment*
  // on stdout — zero complete objects.
  const preload = await writePreload(
    "r12-short-async.js",
    shortWritePreload({ accept: 5, failures: 1, killStdoutStream: false }),
  );
  await withServer(
    () => jsonServer(ALLOW_BODY),
    async (server) => {
      const result = await runInterceptor({
        preload,
        stdin: JSON.stringify(capturedPayload()),
        env: childEnv({ DENIED_URL: server.url, DENIED_API_KEY: "dn_test" }),
      });

      assert.equal(assertDecision(result, "R12 async flush").decision, "allow");
      assert.equal(result.stdout, '{"decision":"allow"}');
      assert.equal(result.stdout.split('{"decision"').length - 1, 1);
    },
  );
});

test("R12 (H15): a short write plus a dead stdout stream is finished by the exit net", { timeout: 30000 }, async () => {
  // The other direction of the same bug: a writer that threw after part of the
  // buffer was already on the wire left the flag false, so the exit net wrote a
  // whole *second* object after the fragment — two objects, unparseable, which
  // denies on this platform. The net must finish the remainder, never restart.
  const preload = await writePreload(
    "r12-short-exit.js",
    shortWritePreload({ accept: 5, failures: 1, killStdoutStream: true }),
  );
  await withServer(
    () => jsonServer({ decision: false, context: { reason: "nope" } }),
    async (server) => {
      const result = await runInterceptor({
        preload,
        stdin: JSON.stringify(capturedPayload()),
        env: childEnv({ DENIED_URL: server.url, DENIED_API_KEY: "dn_test" }),
      });

      const decision = assertDecision(result, "R12 exit net");
      assert.equal(decision.decision, "deny");
      assert.equal(decision.reason, "nope");
      // Exactly one complete object, assembled from the fragment plus its
      // remainder — not the fragment plus a second whole object.
      assert.equal(result.stdout, '{"decision":"deny","reason":"nope"}');
      assert.equal(result.stdout.split('{"decision"').length - 1, 1);
      assert.equal(/Failed to flush/.test(result.stderr), false, result.stderr);
    },
  );
});

test("R12 (H15): an undeliverable remainder never becomes a fragment plus a second object", { timeout: 30000 }, async () => {
  // The unrecoverable case: nothing can deliver the rest. What must still hold
  // is that stdout carries at most one `decision` — a prefix of the object, and
  // never a prefix followed by a whole new one.
  const preload = await writePreload(
    "r12-short-fatal.js",
    shortWritePreload({ accept: 5, failures: 1_000, killStdoutStream: true }),
  );
  await withServer(
    () => jsonServer(ALLOW_BODY),
    async (server) => {
      const result = await runInterceptor({
        preload,
        stdin: JSON.stringify(capturedPayload()),
        env: childEnv({ DENIED_URL: server.url, DENIED_API_KEY: "dn_test" }),
      });

      assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stderr}`);
      // At most one: the fragment here is shorter than the marker itself, and
      // the failure this guards against is a *second* complete object after it.
      assert.ok(
        result.stdout.split('{"decision"').length - 1 <= 1,
        `stdout carried a second decision object: ${JSON.stringify(result.stdout)}`,
      );
      assert.ok(
        '{"decision":"allow"}'.startsWith(result.stdout),
        `stdout was not a prefix of the decision: ${JSON.stringify(result.stdout)}`,
      );
      assert.match(result.stderr, /Failed to flush the rest of the decision/);
    },
  );
});

// ---------------------------------------------------------------------------
// R13 — Timeout budget slack
// ---------------------------------------------------------------------------

test("R13: the timeout budget keeps real slack inside the watchdog and the host timeout", async () => {
  // Read from the constants and from hooks.json rather than hardcoded, so an
  // edit that removes the slack fails here instead of in production: JSON
  // parsing, redaction, the two stringify passes, the audit write and the
  // response drain all happen outside every deadline, and without the slack a
  // PDP answering just inside its deadline loses the race to the watchdog and
  // has its real allow/deny replaced by the failMode outcome.
  const hooks = JSON.parse(
    await fs.readFile(path.join(__dirname, "..", "hooks.json"), "utf-8"),
  );
  const hostTimeoutMs = hooks["denied-authz"].PreToolUse[0].hooks[0].timeout * 1_000;

  // The config read and the stdin read are concurrent (R5), so only the larger
  // of the two spends budget — which is only true while config <= stdin.
  assert.ok(
    DEFAULT_CONFIG_TIMEOUT_MS <= DEFAULT_STDIN_TIMEOUT_MS,
    "a config deadline above the stdin deadline silently shrinks the fetch budget",
  );
  assert.equal(
    MAX_TIMEOUT_MS,
    WATCHDOG_MS -
      Math.max(DEFAULT_STDIN_TIMEOUT_MS, DEFAULT_CONFIG_TIMEOUT_MS) -
      DEFAULT_READ_TIMEOUT_MS,
  );
  // The default budget must not fill the watchdog exactly; the ceiling may.
  assert.equal(DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS - BUDGET_SLACK_MS);
  assert.ok(BUDGET_SLACK_MS > 0, "the default budget has no slack left");
  assert.equal(
    DEFAULT_STDIN_TIMEOUT_MS + DEFAULT_TIMEOUT_MS + DEFAULT_READ_TIMEOUT_MS,
    WATCHDOG_MS - BUDGET_SLACK_MS,
  );
  assert.ok(
    DEFAULT_STDIN_TIMEOUT_MS + DEFAULT_TIMEOUT_MS + DEFAULT_READ_TIMEOUT_MS < WATCHDOG_MS,
    "stdin + fetch + transcript must fit strictly inside the watchdog",
  );
  // The audit deadline lives inside the slack, not beside it.
  assert.ok(
    DEFAULT_AUDIT_TIMEOUT_MS < BUDGET_SLACK_MS,
    "the audit deadline does not fit inside the reserved slack",
  );
  // And the watchdog must beat the host, with room for process startup.
  assert.ok(WATCHDOG_MS < hostTimeoutMs, `${WATCHDOG_MS}ms vs a ${hostTimeoutMs}ms host timeout`);
  assert.ok(
    hostTimeoutMs - WATCHDOG_MS >= 1_000,
    `only ${hostTimeoutMs - WATCHDOG_MS}ms between the watchdog and the host timeout`,
  );
});
