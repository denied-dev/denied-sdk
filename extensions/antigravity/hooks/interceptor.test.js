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
//
// Run with: node --test (Node 18+, zero dependencies).

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs").promises;
const { mkdtempSync, rmSync } = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable, PassThrough } = require("node:stream");

const {
  WATCHDOG_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_STDIN_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_TAIL_BYTES,
  DEFAULT_REDACT_KEYS,
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
