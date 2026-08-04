// Denied SDK – Kiro PreToolUse interceptor (Kiro IDE + Kiro CLI V3).
// Zero dependencies. Requires Node.js 18+ (native fetch).
//
// Invoked as: node interceptor.js [--surface=cli-v2]
//
// The exit code is the entire protocol: 0 allows, 2 blocks. Any other code
// blocks in the IDE but only warns in the CLI, so an uncaught exception — Node
// exits 1 — would silently override the configured failMode in opposite
// directions on the two surfaces. Every terminal path therefore routes through
// exitWith(), whose code comes from resolveExitCode().

const fs = require("node:fs").promises;
const { writeSync } = require("node:fs");
const { createHash } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_URL = "https://api.denied.dev";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FAIL_MODE = "open"; // "open" | "closed"
const DEFAULT_CONTEXT_MAX_BYTES = 20_000;
// Kiro can deliver no stdin at all on some builds, so the read needs its own
// deadline; without one the hook hangs until the host timeout kills it.
const DEFAULT_STDIN_TIMEOUT_MS = 2_000;
// Fires before the 20s host hook timeout the installer configures, so we decide
// the outcome rather than inheriting the host's undocumented timeout behaviour.
const WATCHDOG_MS = 18_000;
const DEFAULT_REDACT_KEYS = [
  "api_key",
  "apikey",
  "authorization",
  "password",
  "secret",
  "token",
];

const EXIT_ALLOW = 0;
const EXIT_DENY = 2;

// One hook file registers both supported surfaces and the payload carries no
// surface marker, so Kiro IDE and CLI V3 are deliberately indistinguishable.
// They share a tool vocabulary, so nothing depends on telling them apart.
const SURFACE_V1 = "kiro-v1";
const SURFACE_CLI_V2 = "cli-v2";

// Kiro documents no way to give a hook command an environment variable, so the
// JSON config file is required here rather than merely convenient. Settings
// resolve from (in order): environment variables, then a JSON config file
// (~/.denied/config.json, override with DENIED_CONFIG), then built-in defaults.
// The file is resolved from os.homedir() and never from process.cwd(), because
// hook cwd is wrong in multi-root workspaces.

function positiveInteger(value, fallback) {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function expandHome(value, homedir) {
  return value === "~" || value.startsWith("~/")
    ? path.join(homedir, value.slice(2))
    : value;
}

function resolveConfigPath(env, homedir) {
  if (env.DENIED_CONFIG) {
    return env.DENIED_CONFIG;
  }
  return path.join(homedir, ".denied", "config.json");
}

// Reads and parses the JSON config file. Returns {} when missing or invalid;
// surfaces a malformed-file warning so silent misconfiguration is debuggable.
async function loadFileConfig(configPath, warn = () => {}) {
  let raw;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    warn(`Ignoring malformed config file at ${configPath} (invalid JSON).`);
    return {};
  }
}

// Merges env vars (highest precedence), file config, and defaults into the
// resolved settings. Pure function — no I/O — for unit testing.
function resolveConfig(env, fileConfig) {
  // A zero or negative timeout would abort every PDP call before it completes —
  // a gate that silently never enforces — so non-positive values fall through.
  const timeoutMs = positiveInteger(
    env.DENIED_TIMEOUT_MS,
    positiveInteger(fileConfig.timeoutMs, DEFAULT_TIMEOUT_MS),
  );
  const requestConfig =
    fileConfig.request && typeof fileConfig.request === "object"
      ? fileConfig.request
      : {};
  const redactionConfig =
    fileConfig.redaction && typeof fileConfig.redaction === "object"
      ? fileConfig.redaction
      : {};
  const auditConfig =
    fileConfig.audit && typeof fileConfig.audit === "object"
      ? fileConfig.audit
      : {};
  const redactKeyList = Array.isArray(redactionConfig.keys)
    ? redactionConfig.keys.filter((key) => typeof key === "string" && key)
    : [];

  return {
    url: env.DENIED_URL || fileConfig.url || DEFAULT_URL,
    apiKey: env.DENIED_API_KEY || fileConfig.apiKey || "",
    failMode: (
      env.DENIED_FAIL_MODE ||
      (typeof fileConfig.failMode === "string" ? fileConfig.failMode : "") ||
      DEFAULT_FAIL_MODE
    ).toLowerCase(),
    timeoutMs,
    includeToolInput: requestConfig.includeToolInput !== false,
    includeHookPayload: requestConfig.includeHookPayload !== false,
    maxContextBytes: positiveInteger(
      requestConfig.maxContextBytes,
      DEFAULT_CONTEXT_MAX_BYTES,
    ),
    // Kiro defaults redaction on, unlike the other extensions: its `fs_write`
    // tool_input carries whole file bodies and `execute_bash` carries full
    // command lines.
    redaction: {
      enabled: redactionConfig.enabled !== false,
      keys: redactKeyList.length ? redactKeyList : DEFAULT_REDACT_KEYS.slice(),
    },
    audit: {
      enabled: auditConfig.enabled === true,
      dir:
        typeof auditConfig.dir === "string" && auditConfig.dir
          ? expandHome(auditConfig.dir, os.homedir())
          : path.join(os.homedir(), ".denied", "audit"),
      includeRawPayload: auditConfig.includeRawPayload !== false,
      includeMappedRequest: auditConfig.includeMappedRequest !== false,
      includeDecision: auditConfig.includeDecision !== false,
    },
  };
}

async function loadRuntimeConfig(
  env = process.env,
  homedir = os.homedir(),
  warn = (message) => writeStderr(`[denied-dev] ${message}\n`),
) {
  const fileConfig = await loadFileConfig(resolveConfigPath(env, homedir), warn);
  return resolveConfig(env, fileConfig);
}

const DEFAULT_CONFIG = resolveConfig(process.env, {});

// Replaced once the file config resolves, so the fatal handlers and the
// watchdog always honour the user's failMode rather than the env-only default.
let activeConfig = DEFAULT_CONFIG;

// ---------------------------------------------------------------------------
// Pure logic (exported for unit testing)
// ---------------------------------------------------------------------------

// The payload cannot identify the surface, so it is taken from argv. The flag
// exists only for the unsupported hand-wired CLI V2 path, where it selects V2
// tool-name normalization.
function resolveSurface(argv = []) {
  const flag = argv.find((arg) => arg.startsWith("--surface="));
  return flag && flag.slice("--surface=".length) === SURFACE_CLI_V2
    ? SURFACE_CLI_V2
    : SURFACE_V1;
}

// Every stdin field is optional and the whole payload may be absent, so an
// unusable payload becomes {} and the check still goes out — with degraded
// fidelity the PDP can see (§4.3 Tier 3) rather than no decision at all.
function parseHookPayload(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

// Canonical vocabulary is the V3/IDE snake_case set, so normalization is the
// identity on both supported surfaces. The table exists for the unsupported
// hand-wired CLI V2 path: without it V2's `read`/`write`/`shell` reach a PDP
// holding policies written for `read_file`/`fs_write`/`execute_bash`, which is
// a silent policy miss — the exact fail-open this gate exists to prevent.
const CLI_V2_TOOL_NAMES = {
  read: "read_file",
  fs_read: "read_file",
  fsRead: "read_file",
  write: "fs_write",
  fs_write: "fs_write",
  fsWrite: "fs_write",
  shell: "execute_bash",
  execute_bash: "execute_bash",
  execute_cmd: "execute_bash",
  grep: "grep_search",
  // No V3/IDE equivalent has been observed for these, so the alias collapses to
  // the V2 canonical name rather than inventing a cross-surface mapping.
  aws: "aws",
  use_aws: "aws",
  subagent: "subagent",
  use_subagent: "subagent",
};

function normalizeToolName(name, surface = SURFACE_V1) {
  if (typeof name !== "string" || !name) {
    return "unknown";
  }
  // MCP tools arrive as `@server/tool` and have no alias form; passing them
  // through intact keeps the server namespace addressable by policy.
  if (surface !== SURFACE_CLI_V2 || name.startsWith("@")) {
    return name;
  }
  // Own-property check only: a bare lookup would resolve `constructor` and
  // `__proto__` to inherited values and rewrite the tool name.
  return Object.hasOwn(CLI_V2_TOOL_NAMES, name)
    ? CLI_V2_TOOL_NAMES[name]
    : name;
}

// Resolves subject.id and records which tier produced it, so a degraded
// identity shows as degraded rather than being presented as a real session.
// Tier 2 must be stable across every tool call of one Kiro process: a random
// per-invocation id would make each tool call look like its own session and
// destroy log correlation entirely.
function resolveSubjectId(input, ppid, cwd) {
  const sessionId =
    typeof input.session_id === "string" ? input.session_id.trim() : "";
  if (sessionId) {
    return { id: sessionId, source: "session_id" };
  }
  if (Number.isInteger(ppid) && ppid > 0) {
    const digest = createHash("sha256")
      .update(`${ppid}:${typeof cwd === "string" ? cwd : ""}`)
      .digest("hex")
      .slice(0, 12);
    return { id: `kiro-${digest}`, source: "process" };
  }
  return { id: "unknown", source: "none" };
}

// Lets a policy author write "if I cannot see the arguments, deny" instead of
// having the PDP guess whether an empty tool_input means a tool that takes no
// arguments or a payload we could not read.
function payloadFidelity(input) {
  const payload = input && typeof input === "object" ? input : {};
  const hasToolName =
    typeof payload.tool_name === "string" && payload.tool_name !== "";
  const toolInput = payload.tool_input;
  const hasToolInput =
    !!toolInput &&
    typeof toolInput === "object" &&
    !Array.isArray(toolInput) &&
    Object.keys(toolInput).length > 0;

  if (hasToolName && hasToolInput) {
    return "full";
  }
  if (hasToolName) {
    return "tool_name_only";
  }
  return "none";
}

function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Matches on the normalized key — lowercased, punctuation stripped, substring —
// so `X-API-Key`, `apiKey` and `api_key` all hit the same `apikey` entry.
function isSensitiveKey(key, keys) {
  const normalized = normalizeKey(key);
  return keys.some((candidate) => {
    const needle = normalizeKey(candidate);
    return needle !== "" && normalized.includes(needle);
  });
}

// Replaces the value of any sensitive key with "[REDACTED]", recursing into
// nested objects and arrays. Non-destructive: the input is never mutated.
// `seen` tracks only the current ancestor path, so a repeated sibling is
// redacted normally and only a genuine cycle becomes "[Circular]". Depth is
// bounded because this runs before main()'s try/catch: a stack overflow here
// would skip the PDP call entirely and degrade to failMode on every deep
// payload, so past the cap the value collapses to a sentinel instead.
const MAX_REDACT_DEPTH = 200;

function redactKeys(
  value,
  keys = DEFAULT_REDACT_KEYS,
  seen = new WeakSet(),
  depth = 0,
) {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  if (depth >= MAX_REDACT_DEPTH) {
    return "[MaxDepth]";
  }
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => redactKeys(item, keys, seen, depth + 1));
  } else {
    result = {};
    for (const [key, nested] of Object.entries(value)) {
      // defineProperty, not assignment: a literal "__proto__" key would hit
      // the prototype setter and silently vanish from what reaches the PDP.
      Object.defineProperty(result, key, {
        value: isSensitiveKey(key, keys)
          ? "[REDACTED]"
          : redactKeys(nested, keys, seen, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  seen.delete(value);
  return result;
}

function truncateJsonValue(value, maxBytes) {
  let raw;
  let serializable = value;
  try {
    raw = JSON.stringify(value);
  } catch {
    serializable = String(value);
    raw = JSON.stringify(serializable);
  }
  const originalBytes = Buffer.byteLength(raw, "utf-8");
  if (originalBytes <= maxBytes) {
    return serializable;
  }
  return {
    truncated: true,
    max_bytes: maxBytes,
    original_bytes: originalBytes,
    preview: truncateUtf8(raw, maxBytes),
  };
}

function truncateUtf8(value, maxBytes) {
  const buffer = Buffer.from(value, "utf-8");
  let end = Math.max(0, Math.min(maxBytes, buffer.length));
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf-8");
}

// Redaction runs before truncation so a secret cannot survive inside a preview.
function boundedContext(value, config) {
  const redacted = config.redaction?.enabled
    ? redactKeys(value, config.redaction.keys)
    : value;
  return truncateJsonValue(redacted, config.maxContextBytes);
}

// Builds the AuthZEN evaluation request body from the Kiro hook input.
//
//   PreToolUse input fields (every one optional — see resolveSubjectId,
//   payloadFidelity and parseHookPayload for the fallbacks):
//     hook_event_name: "PreToolUse" on the v1 surfaces, "preToolUse" on CLI V2
//     cwd: working directory reported by the host
//     session_id: current Kiro session id
//     tool_name: e.g. `read_file`, `fs_write`, `execute_bash`, or `@server/tool`
//     tool_input: tool-specific arguments, e.g. `{path, text}` for `fs_write`

function buildCheckBody(
  input,
  config = DEFAULT_CONFIG,
  surface = SURFACE_V1,
  identity = resolveSubjectId(input, process.ppid, input.cwd),
) {
  const toolInput =
    input.tool_input && typeof input.tool_input === "object"
      ? input.tool_input
      : {};
  const properties = {
    tool_name_canonical: normalizeToolName(input.tool_name, surface),
  };
  if (config.includeToolInput) {
    properties.tool_input = boundedContext(toolInput, config);
  }

  const context = {
    integration: "denied-kiro-hook",
    hook_event_name: input.hook_event_name,
    authz_direction: "agent-to-world",
    payload_fidelity: payloadFidelity(input),
  };
  if (config.includeHookPayload) {
    context.hook_payload = boundedContext(input, config);
  }

  return {
    subject: {
      type: "kiro",
      id: identity.id,
      properties: {
        cwd: input.cwd ?? "unknown",
        surface,
        session_id_source: identity.source,
      },
    },
    action: {
      name: "execute",
    },
    resource: {
      type: "tool",
      // The name exactly as Kiro sent it; the normalized form travels alongside
      // it in properties so policies can match on either.
      id: input.tool_name ?? "unknown",
      properties,
    },
    context,
  };
}

// Maps a PDP response to a decision outcome without performing any I/O.
// Returns { kind: "allow" | "deny" | "error", reason }.
function interpretDecision(data) {
  if (data.decision === true) {
    return {
      kind: "allow",
      reason:
        data.context?.reason ??
        "Authorization allowed by Denied policy engine.",
    };
  }
  if (data.decision === false) {
    return {
      kind: "deny",
      reason:
        data.context?.reason ?? "Authorization denied by Denied policy engine.",
    };
  }
  return {
    kind: "error",
    reason: "Unexpected PDP response: missing or invalid 'decision' field.",
  };
}

// Resolves a fail-safe outcome based on the configured fail mode.
// Returns { kind: "allow" | "deny", reason }.
function resolveFailSafe(failMode, message) {
  if (failMode === "closed") {
    return {
      kind: "deny",
      reason: `Denied policy engine unavailable and fail-mode is closed. ${message}`,
    };
  }
  return {
    kind: "allow",
    reason: `Denied policy engine unavailable and fail-mode is open. ${message}`,
  };
}

// The exit-code invariant, in one place. Only an explicit "allow" exits 0 and
// only an explicit "deny" exits 2 unconditionally; every other outcome kind —
// PDP error, malformed response, missing API key, unreadable stdin, watchdog
// expiry, uncaught exception — resolves through failMode. The result is always
// exactly 0 or 2, so a bug can never leak exit 1 and let the host decide.
function resolveExitCode(outcomeKind, failMode) {
  if (outcomeKind === "allow") {
    return EXIT_ALLOW;
  }
  if (outcomeKind === "deny") {
    return EXIT_DENY;
  }
  return resolveFailSafe(failMode, "").kind === "deny" ? EXIT_DENY : EXIT_ALLOW;
}

// ---------------------------------------------------------------------------
// I/O wrappers
// ---------------------------------------------------------------------------

// Synchronous by necessity: process.exit() discards pending asynchronous writes
// to a piped stderr, and on a deny that stderr text is the reason the agent
// receives. A closed or non-blocking stderr must never become an exit failure.
function writeStderr(message) {
  try {
    writeSync(2, message);
  } catch {
    /* nothing useful to do — the decision still has to be delivered */
  }
}

// The only place this process is allowed to terminate. stdout stays empty on
// every path: all surfaces inject hook stdout into the agent's context on exit
// 0, so writing there would burn tokens on every tool call.
function exitWith(outcomeKind, reason, config = activeConfig, toolName = "") {
  const code = resolveExitCode(outcomeKind, config.failMode);
  if (outcomeKind !== "allow") {
    if (toolName) {
      writeStderr(`[denied-dev] Blocked tool call: ${toolName}\n`);
    }
    writeStderr(`[denied-dev] ${reason}\n`);
  }
  process.exit(code);
}

function failSafeExit(message, config = activeConfig) {
  exitWith("error", resolveFailSafe(config.failMode, message).reason, config);
}

async function appendAuditRecord(input, body, decision, config = DEFAULT_CONFIG) {
  if (!config.audit?.enabled) {
    return;
  }

  try {
    await fs.mkdir(config.audit.dir, { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
    };
    if (config.audit.includeRawPayload) {
      record.hook_payload = boundedContext(input, config);
    }
    if (config.audit.includeMappedRequest) {
      record.mapped_request = truncateJsonValue(body, config.maxContextBytes);
    }
    if (config.audit.includeDecision) {
      record.decision = truncateJsonValue(decision, config.maxContextBytes);
    }
    await fs.appendFile(
      path.join(config.audit.dir, "denied-kiro-hook.jsonl"),
      `${JSON.stringify(record)}\n`,
      "utf-8",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeStderr(`[denied-dev] Failed to write audit record: ${message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Read stdin (Kiro streams the hook context as JSON — sometimes nothing at all)
// ---------------------------------------------------------------------------

// Never throws and never outlives its deadline: whatever arrived (or nothing)
// becomes a payload object and the check proceeds.
async function readStdin(
  stream = process.stdin,
  timeoutMs = DEFAULT_STDIN_TIMEOUT_MS,
) {
  const chunks = [];
  const timer = setTimeout(() => stream.destroy(), timeoutMs);
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
  } catch {
    /* destroyed by the deadline, or unreadable — fall through to what we have */
  } finally {
    clearTimeout(timer);
  }
  return parseHookPayload(Buffer.concat(chunks).toString("utf-8"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv = process.argv.slice(2)) {
  const surface = resolveSurface(argv);
  const config = await loadRuntimeConfig();
  activeConfig = config;

  if (!config.apiKey) {
    failSafeExit(
      "No API key found. Set DENIED_API_KEY or add \"apiKey\" to ~/.denied/config.json. Skipping authorization check.",
      config,
    );
    return;
  }

  const input = await readStdin();
  const identity = resolveSubjectId(input, process.ppid, input.cwd);
  const body = buildCheckBody(input, config, surface, identity);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const headers = {
      "Content-Type": "application/json",
      "X-API-Key": config.apiKey,
    };

    const res = await fetch(`${config.url}/pdp/check`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const error = { error: `HTTP ${res.status}: ${await res.text()}` };
      await appendAuditRecord(input, body, error, config);
      failSafeExit(error.error, config);
      return;
    }

    const data = await res.json();
    await appendAuditRecord(input, body, data, config);
    const outcome = interpretDecision(data);

    if (outcome.kind === "error") {
      failSafeExit(outcome.reason, config);
      return;
    }
    exitWith(outcome.kind, outcome.reason, config, body.resource.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendAuditRecord(input, body, { error: message }, config);
    failSafeExit(`Failed to reach Denied PDP: ${message}`, config);
  } finally {
    clearTimeout(timer);
  }
}

if (require.main === module) {
  const onFatal = (err) =>
    failSafeExit(
      `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  // Deliberately not unref'd: keeping the event loop alive means the process
  // cannot fall off the end and exit with Node's default code instead of ours.
  setTimeout(() => {
    failSafeExit(
      `Watchdog fired after ${WATCHDOG_MS}ms; forcing the configured fail-safe exit.`,
    );
  }, WATCHDOG_MS);
  main().catch(onFatal);
}

module.exports = {
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
  readStdin,
  main,
};
