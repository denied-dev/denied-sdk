// Denied SDK – Antigravity (`agy` CLI) PreToolUse interceptor.
// Zero dependencies. Requires Node.js 18+ (native fetch).
//
// Antigravity's handling of a broken hook is undocumented and version-unstable:
// on agy <= 1.1.7 a non-zero exit / empty stdout / timeout denied the tool call,
// on 1.1.10 all three silently allow it. A missing or unrecognized `decision`
// field, meanwhile, still fails closed. So neither direction can be relied on:
// every code path here exits 0 and prints exactly one well-formed decision
// object, which makes behaviour identical under either host regime.
//
// Invariants (see docs/plans/antigravity-extension-plan.md §5.4):
//   1. always exit 0
//   2. always emit exactly one JSON object carrying a `decision`
//   3. stdout carries the decision and nothing else — diagnostics go to stderr
//   4. the emitted enum is allow | deny | force_ask, never {} and never `block`

const fs = require("node:fs").promises;
const { createReadStream, writeSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_URL = "https://api.denied.dev";
const DEFAULT_FAIL_MODE = "open"; // "open" | "closed" | "ask"
const DEFAULT_CONTEXT_MAX_BYTES = 20_000;
const DEFAULT_TAIL_BYTES = 65_536; // 64 KB tail window for the transcript read

// Timeout budget. The hook file registers `timeout: 10` (seconds) with the host,
// so the watchdog must fire first, and the inner deadlines must fit inside the
// watchdog: max(stdin, config) + fetch + transcript + slack < watchdog < host
// timeout. The config read and the stdin read are independent and run
// concurrently, so only the larger of the two spends budget — and
// DEFAULT_CONFIG_TIMEOUT_MS must stay <= DEFAULT_STDIN_TIMEOUT_MS or the fetch
// budget below shrinks.
//
// MAX_TIMEOUT_MS is the ceiling a *configured* timeoutMs is clamped to, and at
// that ceiling the deadlines exactly fill the watchdog. The default budget must
// not: JSON parsing, redaction, the two stringify passes, the audit write and
// the response drain all happen outside every deadline, so the default fetch
// timeout is derived by subtracting BUDGET_SLACK_MS from the ceiling. Without
// it a PDP answering just inside its deadline loses the race to the watchdog
// and has its real allow/deny replaced by the failMode outcome.
const WATCHDOG_MS = 8_500;
const DEFAULT_STDIN_TIMEOUT_MS = 2_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 1_000; // config file read
const DEFAULT_READ_TIMEOUT_MS = 1_000; // transcript tail read
const MAX_TIMEOUT_MS =
  WATCHDOG_MS -
  Math.max(DEFAULT_STDIN_TIMEOUT_MS, DEFAULT_CONFIG_TIMEOUT_MS) -
  DEFAULT_READ_TIMEOUT_MS;
// Reserved for the work that no deadline covers, the audit write included.
const BUDGET_SLACK_MS = 1_500;
const DEFAULT_AUDIT_TIMEOUT_MS = 500; // audit append, inside the slack above
const DEFAULT_TIMEOUT_MS = MAX_TIMEOUT_MS - BUDGET_SLACK_MS; // PDP fetch

// Inbound bounds. `maxContextBytes` governs only what we send; these govern
// what we accept and what we print, and all three are hard limits rather than
// settings: an unbounded `res.json()` on a large body is an out-of-memory abort
// (SIGABRT — uncatchable, zero stdout, every safety net below bypassed), and an
// unbounded reason writes megabytes into a pipe the host may not be draining.
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REASON_BYTES = 4_096;

// stdin is exactly as model-influenced as the PDP response, and until this cap
// existed it was bounded by time alone: everything that arrived inside the
// stdin deadline was buffered, stringified ~4x and deep-copied twice on the
// synchronous decision path. Measured on the unfixed build: a 600 MB payload
// died in Buffer.concat().toString() ("Cannot create a string longer than
// 0x1fffffe8 characters") and the check was never sent — the deny/allow the PDP
// would have given was replaced by the failMode outcome. Capping here, at the
// one input boundary, is what bounds every synchronous consumer downstream:
// no timer and no signal handler can preempt synchronous work, so a stage that
// is not bounded by size is not bounded at all.
//
// Exceeding the cap never cancels the check. The prefix is repaired back into
// an object (see repairTruncatedJson) so the fields policy needs most —
// resource.id and subject.id — survive, and the request is marked oversized so
// the PDP knows it is judging a cut payload.
const MAX_STDIN_BYTES = 1_048_576;

// The tool name is model-controlled, reaches the PDP as `resource.id`, and is
// run through NAME_EFFECT_PATTERNS. A megabyte-long "tool name" is not a tool
// name; bounding it keeps both the request and the pattern scan small.
const MAX_TOOL_NAME_BYTES = 1_024;

const FAIL_MODES = ["open", "closed", "ask"];
const DEFAULT_REDACT_KEYS = [
  "api_key",
  "apikey",
  "authorization",
  "password",
  "secret",
  "token",
];

const STDOUT_FD = 1;
const STDERR_FD = 2;
// Bounds the EAGAIN retry loop and the async-flush fallback below. It cannot
// bound a *blocking* write: libuv clears O_NONBLOCK on child stdio, so on a
// spawned hook writeSync blocks inside the syscall instead of throwing EAGAIN
// and no deadline is reachable from JS. What keeps that from hanging is the
// MAX_REASON_BYTES cap — every emitted object stays a few KB, well inside the
// OS pipe buffer, so one writeSync always completes even if nothing is reading.
const FLUSH_GRACE_MS = 500;

// Antigravity gives hooks no environment-variable mechanism of its own on GUI
// surfaces, and an `export` only lasts for the launching shell on the CLI, so
// settings resolve from (in order): environment variables, then a JSON config
// file (~/.denied/config.json, override with DENIED_CONFIG), then defaults.
// The file is resolved from os.homedir() and never from process.cwd(), because
// the hook's cwd is the directory containing hooks.json.

// ---------------------------------------------------------------------------
// Configuration (pure, injectable env/homedir)
// ---------------------------------------------------------------------------

function positiveInteger(value, fallback) {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function describeType(value) {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
}

function expandHome(value, homedir = os.homedir()) {
  if (typeof value !== "string") {
    return value;
  }
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

const CONFIG_UNREADABLE = Symbol("config-unreadable");
const CONFIG_TIMED_OUT = Symbol("config-timed-out");

// Reads and parses the JSON config file. Returns {} when missing or invalid;
// surfaces a malformed-file warning so silent misconfiguration is debuggable.
//
// The read carries its own deadline, and it is raced rather than only aborted:
// a config file on a wedged filesystem (FIFO, NFS, FUSE) blocks in the
// threadpool where an AbortSignal cannot reach it, and until this resolves the
// fatal handlers and the watchdog are still holding the env-only default —
// which silently converts `failMode: closed` into an allow.
async function loadFileConfig(
  configPath,
  warn = () => {},
  timeoutMs = DEFAULT_CONFIG_TIMEOUT_MS,
) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(CONFIG_TIMED_OUT);
    }, timeoutMs);
  });
  let raw;
  try {
    raw = await Promise.race([
      fs
        .readFile(configPath, { encoding: "utf-8", signal: controller.signal })
        .catch(() => CONFIG_UNREADABLE),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (raw === CONFIG_TIMED_OUT) {
    // Distinct from "no config file": the user's settings exist and did not
    // arrive, so whatever is decided next is decided on defaults.
    warn(
      `Config read at ${configPath} timed out after ${timeoutMs}ms; deciding on environment variables and defaults instead (failMode may not be yours).`,
    );
    return {};
  }
  if (raw === CONFIG_UNREADABLE) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    // Well-formed JSON of the wrong shape discards every setting including
    // apiKey and failMode, so it cannot pass silently: the file is the primary
    // configuration surface on this platform.
    warn(
      `Ignoring config file at ${configPath}: expected a JSON object, found ${describeType(parsed)}.`,
    );
    return {};
  } catch {
    warn(`Ignoring malformed config file at ${configPath} (invalid JSON).`);
    return {};
  }
}

// Merges env vars (highest precedence), file config, and defaults into the
// resolved settings. Pure function — no I/O — for unit testing.
function resolveConfig(env, fileConfig, warn = () => {}, homedir = os.homedir()) {
  const source = fileConfig && typeof fileConfig === "object" ? fileConfig : {};
  const requestConfig =
    source.request && typeof source.request === "object" ? source.request : {};
  const redactionConfig =
    source.redaction && typeof source.redaction === "object"
      ? source.redaction
      : {};
  const auditConfig =
    source.audit && typeof source.audit === "object" ? source.audit : {};

  // A zero or negative timeout would abort every PDP call before it completes —
  // a gate that silently never enforces — so non-positive values fall through.
  const requested = positiveInteger(
    env.DENIED_TIMEOUT_MS,
    positiveInteger(source.timeoutMs, DEFAULT_TIMEOUT_MS),
  );
  let timeoutMs = requested;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    // Past this point the fetch could outlive the watchdog, which would convert
    // a slow PDP into a watchdog fail-safe instead of the configured outcome.
    warn(
      `timeoutMs ${requested}ms exceeds the ${WATCHDOG_MS}ms watchdog budget; clamping to ${MAX_TIMEOUT_MS}ms.`,
    );
    timeoutMs = MAX_TIMEOUT_MS;
  }

  // A present-but-unusable failMode of any type is a misconfiguration, and on a
  // platform where the config file is the only practical mechanism it would
  // otherwise land silently on the permissive side. Absence is the only thing
  // that may reach the default quietly — and "present but blank" is not
  // absence: `""` and `"   "` are strings a user typed (or a template rendered
  // empty), so they warn like every other unusable value rather than falling
  // through the empty-string fallback in silence.
  const fileFailMode = Object.hasOwn(source, "failMode")
    ? source.failMode
    : undefined;
  if (fileFailMode !== undefined && typeof fileFailMode !== "string") {
    warn(
      `Ignoring non-string failMode (${describeType(fileFailMode)}) in the config file; falling back to "${DEFAULT_FAIL_MODE}".`,
    );
  }
  const envFailMode = env.DENIED_FAIL_MODE;
  if (typeof envFailMode === "string" && envFailMode.trim() === "") {
    warn(
      `Ignoring blank DENIED_FAIL_MODE; falling back to the config file or "${DEFAULT_FAIL_MODE}".`,
    );
  }
  if (typeof fileFailMode === "string" && fileFailMode.trim() === "") {
    warn(
      `Ignoring blank failMode in the config file; falling back to "${DEFAULT_FAIL_MODE}".`,
    );
  }
  const requestedFailMode = (
    (typeof envFailMode === "string" ? envFailMode.trim() : "") ||
    (typeof fileFailMode === "string" ? fileFailMode.trim() : "") ||
    DEFAULT_FAIL_MODE
  )
    .toString()
    .trim()
    .toLowerCase();
  let failMode = requestedFailMode;
  if (!FAIL_MODES.includes(failMode)) {
    warn(
      `Unknown failMode "${requestedFailMode}"; falling back to "${DEFAULT_FAIL_MODE}".`,
    );
    failMode = DEFAULT_FAIL_MODE;
  }

  const redactKeyList = Array.isArray(redactionConfig.keys)
    ? redactionConfig.keys.filter((key) => typeof key === "string" && key)
    : [];

  // A whitespace-only env var is truthy, so it would override a valid config
  // value and then fail every fetch — a silent fail-open under the default
  // failMode. The usual cause is a template that rendered an env var empty.
  const envOverride = (name) => {
    const value = env[name];
    if (typeof value === "string" && value !== "" && value.trim() === "") {
      warn(`Ignoring blank ${name}; falling back to the config file value.`);
      return "";
    }
    return value;
  };

  return {
    url: envOverride("DENIED_URL") || source.url || DEFAULT_URL,
    apiKey: envOverride("DENIED_API_KEY") || source.apiKey || "",
    failMode,
    timeoutMs,
    surface: typeof source.surface === "string" && source.surface
      ? source.surface
      : "unknown",
    includeToolInput: requestConfig.includeToolInput !== false,
    includeHookPayload: requestConfig.includeHookPayload !== false,
    includeLastUserPrompt: requestConfig.includeLastUserPrompt !== false,
    maxContextBytes: positiveInteger(
      requestConfig.maxContextBytes,
      DEFAULT_CONTEXT_MAX_BYTES,
    ),
    // Redaction defaults on here (unlike codex/claude-code): `run_command`
    // ships whole command lines and `write_to_file` whole file bodies.
    redaction: {
      enabled: redactionConfig.enabled !== false,
      keys: redactKeyList.length ? redactKeyList : DEFAULT_REDACT_KEYS.slice(),
    },
    audit: {
      enabled: auditConfig.enabled === true,
      dir:
        typeof auditConfig.dir === "string" && auditConfig.dir
          ? expandHome(auditConfig.dir, homedir)
          : path.join(homedir, ".denied", "audit"),
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
  return resolveConfig(env, fileConfig, warn, homedir);
}

const DEFAULT_CONFIG = resolveConfig(process.env, {});

// Replaced once the file config resolves, so the fatal handlers and the
// watchdog always honour the user's failMode rather than the env-only default.
let activeConfig = DEFAULT_CONFIG;

// ---------------------------------------------------------------------------
// Redaction (ported from extensions/hermes/src/denied_hermes/redaction.py)
// ---------------------------------------------------------------------------

function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Matches on the normalized key — lowercased, punctuation stripped, substring —
// so `X-API-Key`, `apiKey` and `api_key` all hit the same `apikey` entry.
function isSensitiveKey(key, keys = DEFAULT_REDACT_KEYS) {
  const normalized = normalizeKey(key);
  return keys.some((candidate) => {
    const needle = normalizeKey(candidate);
    return needle !== "" && normalized.includes(needle);
  });
}

// Every pattern below runs on model-controllable text, so each one must cost
// linear time in the length of that text. The rule that keeps them linear: no
// two adjacent quantifiers may match the same character. `\s*(?:bearer|basic)?\s+`
// broke it — the two whitespace runs share every split point, so a long run of
// spaces followed by no match backtracks quadratically (measured: 120 KB of
// spaces after `authorization:` took 13 s, 256 KB took 57 s). This work is
// synchronous, so the watchdog timer cannot fire underneath it and the host's
// own timeout decides the tool call instead of us.
const SECRET_STRING_PATTERNS = [
  // `authorization: <token>`, with the scheme word optional but never sharing
  // whitespace with the separator that follows it.
  [/(\bauthorization:\s*(?:(?:bearer|basic)\s+)?)([^\s"';&|]+)/gi, "$1[REDACTED]"],
  [
    /(\b(?:api[_-]?key|apikey|token|secret|password|authorization)\b\s*=\s*)([^\s"';&|]+)/gi,
    "$1[REDACTED]",
  ],
  [
    /(--(?:api[-_]?key|token|secret|password|authorization)(?:=|\s+))([^\s"';&|]+)/gi,
    "$1[REDACTED]",
  ],
];

// Second defence, independent of any pattern's shape: a string this large is
// bound for a truncated preview anyway (maxContextBytes defaults to 20 KB), so
// it is cut *before* it is scanned rather than scanned at full length. Cutting
// first — never passing it through unscanned — is what keeps the tail of a
// `write_to_file` body from reaching the PDP with its secrets intact.
const MAX_REDACT_STRING_BYTES = 16_384;

// Catches secrets that ride inside free-form strings — `run_command` command
// lines are the reason redaction is on by default on this platform. Key-based
// redaction alone would leave `curl -H "authorization: bearer …"` intact.
function redactStringSecrets(value) {
  if (typeof value !== "string") {
    return value;
  }
  let result =
    Buffer.byteLength(value, "utf-8") > MAX_REDACT_STRING_BYTES
      ? truncatePromptString(value, MAX_REDACT_STRING_BYTES)
      : value;
  for (const [pattern, replacement] of SECRET_STRING_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// Depth is bounded because this runs before the PDP call: a stack overflow here
// would skip the check entirely and degrade to failMode on every deep payload.
const MAX_REDACT_DEPTH = 200;

// `seen` tracks only the current ancestor path, so a repeated sibling is
// redacted normally and only a genuine cycle becomes "[Circular]".
function redactValue(
  value,
  keys = DEFAULT_REDACT_KEYS,
  seen = new WeakSet(),
  depth = 0,
) {
  if (typeof value === "string") {
    return redactStringSecrets(value);
  }
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
    result = value.map((item) => redactValue(item, keys, seen, depth + 1));
  } else {
    result = {};
    for (const [key, nested] of Object.entries(value)) {
      // defineProperty, not assignment: a literal "__proto__" key would hit
      // the prototype setter and silently vanish from what reaches the PDP.
      Object.defineProperty(result, key, {
        value: isSensitiveKey(key, keys)
          ? "[REDACTED]"
          : redactValue(nested, keys, seen, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  seen.delete(value);
  return result;
}

// ---------------------------------------------------------------------------
// Truncation (semantics shared with the codex / claude-code interceptors)
// ---------------------------------------------------------------------------

function truncateUtf8(value, maxBytes) {
  const buffer = Buffer.from(value, "utf-8");
  let end = Math.max(0, Math.min(maxBytes, buffer.length));
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf-8");
}

// `priorBytes` carries the size the value had before redaction: redaction can
// shrink a value below maxBytes (it caps oversized strings), and a payload that
// was cut must still reach the PDP marked as cut.
function truncateJsonValue(value, maxBytes, priorBytes = 0) {
  let raw;
  let serializable = value;
  try {
    raw = JSON.stringify(value);
  } catch {
    serializable = String(value);
    raw = JSON.stringify(serializable);
  }
  const originalBytes = Math.max(Buffer.byteLength(raw, "utf-8"), priorBytes);
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

// The prompt stays a string (rather than the object preview above) so policies
// can pattern-match it; the marker keeps the truncation visible to the PDP.
function truncatePromptString(value, maxBytes) {
  const bytes = Buffer.byteLength(value, "utf-8");
  if (bytes <= maxBytes) {
    return value;
  }
  const marker = ` … [truncated ${bytes} bytes]`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf-8"));
  return truncateUtf8(value, budget) + marker;
}

function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf-8");
  } catch {
    return 0;
  }
}

// Redaction runs before truncation so a secret cannot survive inside a preview,
// and the pre-redaction size decides the truncation marker: redaction caps
// oversized strings, which can drop a 10 MB payload below maxContextBytes and
// would otherwise reach the PDP looking complete.
function boundedContext(value, config) {
  if (!config.redaction?.enabled) {
    return truncateJsonValue(value, config.maxContextBytes);
  }
  const originalBytes = jsonByteLength(value);
  return truncateJsonValue(
    redactValue(value, config.redaction.keys),
    config.maxContextBytes,
    originalBytes,
  );
}

// ---------------------------------------------------------------------------
// Payload handling (every field is optional — see plan §5.2)
// ---------------------------------------------------------------------------

// Unparseable or empty stdin degrades to {} and the check still goes out with
// "unknown" ids: a garbage payload is not a reason to stop asking the PDP.
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

// Rebuilds a parseable object from a JSON document that the stdin ceiling cut
// mid-way. Returns null when nothing usable can be recovered.
//
// The alternative — dropping an oversized payload entirely — throws away the
// two fields policy needs most (`resource.id` and `subject.id`), and they are
// exactly the fields a caller cannot move past the cut. One linear scan tracks
// string state and the container stack, and two candidates are tried in order:
//   1. close the string the cut landed inside, then close every open container
//      — this keeps the bulky value that caused the overflow, truncated, which
//      is what boundedContext would have done to it anyway;
//   2. rewind to the last point at which appending closers alone yields a valid
//      document, and close there — used when the cut landed inside a *key*,
//      where a closed string cannot be followed by `}`.
// Both are parse-verified before they are returned: a repair that does not
// parse is not a repair.
function repairTruncatedJson(text) {
  if (typeof text !== "string" || !text) {
    return null;
  }
  const stack = []; // { closer, isObject, expectKey }
  let inString = false;
  let escaped = false;
  let unicodeRemaining = 0;
  let escapeStart = -1;
  let stringIsKey = false;
  // Index (exclusive) of the last position where closing every open container
  // finishes the document. `{` and `[` qualify (an empty container closes), as
  // does any completed value; `,` and `:` do not, so the safe point sits
  // *before* a dangling comma.
  let safeEnd = -1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (unicodeRemaining > 0) {
        unicodeRemaining -= 1;
      } else if (escaped) {
        escaped = false;
        if (ch === "u") {
          unicodeRemaining = 4;
        }
      } else if (ch === "\\") {
        escaped = true;
        escapeStart = i;
      } else if (ch === '"') {
        inString = false;
        if (!stringIsKey) {
          safeEnd = i + 1; // a string *value* completes the slot it fills
        }
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      escaped = false;
      unicodeRemaining = 0;
      escapeStart = -1;
      const top = stack[stack.length - 1];
      stringIsKey = Boolean(top && top.isObject && top.expectKey);
    } else if (ch === "{" || ch === "[") {
      const isObject = ch === "{";
      stack.push({ closer: isObject ? "}" : "]", isObject, expectKey: isObject });
      safeEnd = i + 1;
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      safeEnd = i + 1;
    } else if (ch === ":") {
      const top = stack[stack.length - 1];
      if (top && top.isObject) {
        top.expectKey = false;
      }
    } else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top && top.isObject) {
        top.expectKey = true;
      }
      safeEnd = i; // cut *before* the comma; a trailing comma is not JSON
    }
  }

  // Every push and every pop moves safeEnd, so the stack has not changed since
  // the last time it moved: one closer list serves both candidates.
  const closers = stack
    .map((frame) => frame.closer)
    .reverse()
    .join("");

  const candidates = [];
  if (inString && !stringIsKey) {
    const cut = escaped || unicodeRemaining > 0 ? escapeStart : text.length;
    if (cut > 0) {
      candidates.push(`${text.slice(0, cut)}"${closers}`);
    }
  }
  if (safeEnd > 0) {
    candidates.push(text.slice(0, safeEnd) + closers);
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      /* try the next, more conservative, candidate */
    }
  }
  return null;
}

// Oversized payloads carry their provenance on a non-enumerable symbol rather
// than a field: the payload is echoed to the PDP as `hook_payload` and stored
// in the audit log, and an injected marker key would be indistinguishable there
// from something Antigravity actually sent.
const OVERSIZED = Symbol("denied.oversizedPayload");

function markOversized(payload, info) {
  if (payload && typeof payload === "object") {
    Object.defineProperty(payload, OVERSIZED, {
      value: info,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return payload;
}

function oversizedInfo(payload) {
  return payload && typeof payload === "object" ? payload[OVERSIZED] : undefined;
}

// Antigravity arg keys are PascalCase (`CommandLine`, `Cwd`, `DirectoryPath`),
// unlike every other agent we integrate with, and the casing is undocumented —
// so every lookup into args is case-insensitive.
function caseInsensitiveGet(source, key) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  if (Object.hasOwn(source, key)) {
    return source[key];
  }
  const wanted = String(key).toLowerCase();
  for (const candidate of Object.keys(source)) {
    if (candidate.toLowerCase() === wanted) {
      return source[candidate];
    }
  }
  return undefined;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// `toolCall` has been observed null (antigravity-cli#395), and the args nesting
// has changed once already (`arguments` is the legacy spelling).
function normalizeToolCall(input) {
  const payload = plainObject(input) ?? {};
  const toolCall = plainObject(payload.toolCall) ?? {};
  return {
    // Bounded, with the truncation marker left visible: `resource.id` has to
    // survive, but it does not have to survive at any size (MAX_TOOL_NAME_BYTES).
    name:
      typeof toolCall.name === "string" && toolCall.name
        ? truncatePromptString(toolCall.name, MAX_TOOL_NAME_BYTES)
        : "unknown",
    args: plainObject(toolCall.args) ?? plainObject(toolCall.arguments) ?? {},
  };
}

// The profile directory embedded in the payload paths identifies the surface,
// so policies get a free discriminator with no install-time stamping. Order
// matters: the bare `/antigravity/` marker is a substring of neither `-cli` nor
// `-ide`, but checking it first would still be wrong if the names ever change.
const SURFACE_MARKERS = [
  ["/antigravity-cli/", "cli"],
  ["/antigravity-ide/", "ide"],
  ["/antigravity/", "app"],
];

function deriveSurface(input, fallback = "unknown") {
  const payload = plainObject(input) ?? {};
  for (const candidate of [payload.artifactDirectoryPath, payload.transcriptPath]) {
    if (typeof candidate !== "string" || !candidate) {
      continue;
    }
    const normalized = candidate.replace(/\\/g, "/");
    for (const [marker, surface] of SURFACE_MARKERS) {
      if (normalized.includes(marker)) {
        return surface;
      }
    }
  }
  return typeof fallback === "string" && fallback ? fallback : "unknown";
}

function workspacePathList(input) {
  const payload = plainObject(input) ?? {};
  return Array.isArray(payload.workspacePaths)
    ? payload.workspacePaths.filter((entry) => typeof entry === "string" && entry)
    : [];
}

// ---------------------------------------------------------------------------
// Effect inference (ported from extensions/hermes/src/denied_hermes/mapper.py)
// ---------------------------------------------------------------------------

// Command lines are model-controlled text, so the linearity rule stated above
// SECRET_STRING_PATTERNS applies here too — and a negative lookahead is not
// exempt from it. `echo(?!\s.*>)` used to guard the "read" classification, and
// its unanchored greedy `.*` was re-evaluated to end-of-string at *every*
// `echo`: measured on the unfixed build, `"echo " * n + ">"` cost 156 ms at
// 80 KB, 621 ms at 160 KB, 2.5 s at 320 KB and 26 s at 1 MB — a clean 4x per
// doubling, all of it synchronous and therefore un-preemptable by the watchdog
// timer or by a signal handler, so the host's own timeout decided the tool call
// instead of us. The redirection pattern below already owns the "a redirect
// makes this a create" case; the lookahead only duplicated it, and only for the
// redirect shapes that pattern deliberately ignores (`>` at end of input, or a
// `|>` pipeline). `echo` with no usable redirect now classifies as "read",
// which is what it does.
const SHELL_EFFECT_PATTERNS = [
  [/\b(rm|rmdir|unlink)\b/i, "delete"],
  [/\bsed\s+-i\b/i, "update"],
  [/\bchmod\b|\bchown\b|\bchgrp\b/i, "update"],
  [/[^|]>\s*\S|[^|]>>\s*\S/, "create"],
  [/\b(cp|mv|mkdir|touch|rsync|scp|wget\s+-O|curl\s+-o)\b/i, "create"],
  [/\b(tee|dd)\b/i, "create"],
  [
    /\b(cat|head|tail|less|more|grep|find|ls|pwd|whoami|echo|file|stat|wc|diff|which|type|env|printenv|date|uname)\b/i,
    "read",
  ],
];

function inferShellEffect(command) {
  if (typeof command !== "string" || !command) {
    return "execute";
  }
  for (const [pattern, effect] of SHELL_EFFECT_PATTERNS) {
    if (pattern.test(command)) {
      return effect;
    }
  }
  return "execute";
}

// Antigravity's published built-in tool list (plan §5.10). Unknown and MCP tool
// names are deliberately absent: they fall through to the generic name patterns
// and then to "execute", and reach the PDP as `resource.id` untouched.
const ANTIGRAVITY_TOOL_EFFECTS = {
  view_file: "read",
  list_dir: "read",
  find_by_name: "read",
  grep_search: "read",
  search_web: "read",
  read_url_content: "read",
  write_to_file: "create",
  generate_image: "create",
  replace_file_content: "update",
  multi_replace_file_content: "update",
};

// Same linearity rule, same measurement. `add_.*_member` was the second copy of
// the SHELL_EFFECT_PATTERNS bug: `(^|_)` restarts the match at every underscore,
// and at every one that begins `add_` the greedy `.*` ran to end-of-string and
// backtracked. Measured on the unfixed build, a tool name of `"add_" * n` cost
// 7 ms at 8 KB, 98 ms at 32 KB and 1.56 s at 128 KB — quadratic, on a string
// that arrives straight from the payload. `[^_]*` cannot cross the underscore
// that terminates it, so each restart scans one segment and the total is linear.
// The cost is that only a single-segment role matches (`add_project_member`,
// not `add_org_team_member`); the effect is advisory metadata, the tool name
// itself still reaches the PDP verbatim.
const NAME_EFFECT_PATTERNS = [
  [
    /^(read|glob|grep|webfetch|websearch|web_search|listmcpresourcestool|readmcpresourcetool)$/i,
    "read",
  ],
  [/^(write|notebookedit)$/i, "create"],
  [/^(edit|multiedit|patch)$/i, "update"],
  [/(^|_)(execute|run|call|invoke|batch)(_|$)/i, "execute"],
  [/(^|_)(share|add_[^_]*_member)(_|$)/i, "update"],
  [/(^|_)(merge|fork|copy|move)(_|$)/i, "update"],
  [/(^|_)(lock|unlock|restore)(_|$)/i, "update"],
  [/(^|_)(delete|remove|drop|unshare)(_|$)/i, "delete"],
  [/(^|_)(update|modify|edit|change|set|patch|rename|mark)(_|$)/i, "update"],
  [/(^|_)(write|create|add|insert|post|save|send|upload)(_|$)/i, "create"],
  [/(^|_)(read|get|fetch|load|list|search|query|retrieve)(_|$)/i, "read"],
];

function inferEffect(toolName, args) {
  const name = typeof toolName === "string" ? toolName : "";
  const lower = name.toLowerCase();
  if (lower === "run_command") {
    return inferShellEffect(caseInsensitiveGet(args, "CommandLine"));
  }
  if (Object.hasOwn(ANTIGRAVITY_TOOL_EFFECTS, lower)) {
    return ANTIGRAVITY_TOOL_EFFECTS[lower];
  }
  for (const [pattern, effect] of NAME_EFFECT_PATTERNS) {
    if (pattern.test(name)) {
      return effect;
    }
  }
  return "execute";
}

// ---------------------------------------------------------------------------
// Last user prompt (best-effort; schema pinned in
// docs/spikes/step-0/antigravity-transcript-schema.md)
// ---------------------------------------------------------------------------

// `transcriptPath` arrives tilde-prefixed, absolute, or workspace-relative —
// all three forms are documented or captured, so all three are handled before
// any filesystem call.
function resolveTranscriptPath(rawPath, workspacePaths = [], cwd = process.cwd(), homedir = os.homedir()) {
  if (typeof rawPath !== "string" || !rawPath) {
    return null;
  }
  const expanded = expandHome(rawPath, homedir);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  const base =
    (Array.isArray(workspacePaths) &&
      workspacePaths.find((entry) => typeof entry === "string" && entry)) ||
    (typeof cwd === "string" && cwd ? cwd : process.cwd());
  return path.resolve(base, expanded);
}

// USER_INPUT lines are byte-identical in both files, but `transcript.jsonl`
// double-encodes tool-call args, so the `_full` sibling is preferred whenever
// the payload named the plain one.
function transcriptCandidates(resolvedPath) {
  if (!resolvedPath) {
    return [];
  }
  if (path.basename(resolvedPath) === "transcript.jsonl") {
    return [
      path.join(path.dirname(resolvedPath), "transcript_full.jsonl"),
      resolvedPath,
    ];
  }
  return [resolvedPath];
}

const USER_REQUEST_OPEN = "<USER_REQUEST>\n";
const USER_REQUEST_CLOSE = "\n</USER_REQUEST>";

// Scans a transcript tail (newest content last) for the most recent USER_INPUT
// record and unwraps its <USER_REQUEST> block. Pure: no I/O. Returns null when
// nothing usable is found.
function extractLastUserPrompt(text) {
  if (typeof text !== "string" || !text) {
    return null;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    let record;
    try {
      // A mid-file tail window often starts with a partial line that fails to
      // parse; skip those and keep scanning backwards.
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !record ||
      typeof record !== "object" ||
      record.type !== "USER_INPUT" ||
      typeof record.content !== "string"
    ) {
      continue;
    }
    // Two indexOf calls rather than the obvious regex, and for the reason
    // stated above SECRET_STRING_PATTERNS: `/<USER_REQUEST>\n([\s\S]*?)\n<\/USER_REQUEST>/`
    // is quadratic in the number of *unclosed* opening markers in one record —
    // the engine restarts the lazy body at each one and walks it to the next
    // candidate close. Measured on the unfixed build: 5,000 markers 43 ms,
    // 10,000 markers 173 ms, 20,000 markers (300 KB in a single `content`)
    // 695 ms, a clean 4x per doubling. It was not reachable — DEFAULT_TAIL_BYTES
    // caps the window at 64 KB, so ~4,300 markers was the ceiling — but the
    // window was the only thing holding the line, and a larger tail is one
    // config change away. The scan below is linear in the record length, so the
    // bound is now in the code rather than in a constant somewhere else.
    // Semantics are unchanged: the first opening marker, then the earliest
    // closing marker after it, so a trailing <USER_SETTINGS_CHANGE> block is not
    // swallowed and a prompt containing the closing tag fails short, not open.
    const open = record.content.indexOf(USER_REQUEST_OPEN);
    if (open === -1) {
      return record.content;
    }
    const bodyStart = open + USER_REQUEST_OPEN.length;
    const close = record.content.indexOf(USER_REQUEST_CLOSE, bodyStart);
    return close === -1
      ? record.content
      : record.content.slice(bodyStart, close);
  }
  return null;
}

// fsPromises.stat takes no AbortSignal, so the deadline is applied by racing
// it: on a wedged filesystem the stat would otherwise hang unbounded, outside
// the read budget it is supposed to be inside. The losing promise is settled
// through Promise.race, so a late rejection is never unhandled.
function abortable(promise, signal) {
  if (!signal) {
    return promise;
  }
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const abort = () => reject(new Error("aborted"));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }),
  ]);
}

async function readTail(filePath, maxTailBytes, signal) {
  try {
    const { size } = await abortable(fs.stat(filePath), signal);
    if (size === 0) {
      return null;
    }
    const start = Math.max(0, size - maxTailBytes);
    const stream = createReadStream(filePath, { start, end: size - 1, signal });
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf-8");
  } catch {
    return null;
  }
}

// Bounded tail read with its own deadline, independent of the PDP fetch budget.
// Best-effort throughout: a missing file, parse failure, absent record or read
// timeout resolves to null so the decision is never delayed or failed.
async function readLastUserPrompt(
  transcriptPath,
  maxTailBytes = DEFAULT_TAIL_BYTES,
  readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
) {
  if (!transcriptPath) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), readTimeoutMs);
  try {
    for (const candidate of transcriptCandidates(transcriptPath)) {
      const text = await readTail(candidate, maxTailBytes, controller.signal);
      const prompt = extractLastUserPrompt(text);
      if (typeof prompt === "string" && prompt) {
        return prompt;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// AuthZEN mapping
// ---------------------------------------------------------------------------

//   PreToolUse stdin fields (all optional, none guaranteed):
//     toolCall: { name, args } — may be null; `arguments` is the legacy key
//     stepIdx: index of the step within the conversation
//     conversationId: subagents get their own, distinct from the parent's
//     workspacePaths: array of workspace roots
//     transcriptPath / artifactDirectoryPath: tilde, absolute or relative
//     modelName: active model slug
//   There is no hook_event_name field — it is hardcoded below (plan §5.2).

function buildCheckBody(input, config = DEFAULT_CONFIG, options = {}) {
  const payload = plainObject(input) ?? {};
  const { name: toolName, args } = normalizeToolCall(payload);
  const workspacePaths = workspacePathList(payload);
  const argCwd = caseInsensitiveGet(args, "Cwd");
  const cwd =
    (typeof argCwd === "string" && argCwd) || workspacePaths[0] || "unknown";

  const resourceProperties = {};
  if (config.includeToolInput) {
    resourceProperties.tool_input = boundedContext(args, config);
  }

  const context = {
    integration: "denied-antigravity-hook",
    hook_event_name: "PreToolUse",
    authz_direction: "agent-to-world",
    artifact_directory_path:
      typeof payload.artifactDirectoryPath === "string"
        ? payload.artifactDirectoryPath
        : null,
  };
  if (config.includeHookPayload) {
    context.hook_payload = boundedContext(payload, config);
  }
  // Only present when stdin hit its ceiling, so a policy can tell "the agent
  // sent this" from "this is as much of it as we were willing to read". Without
  // it a repaired payload is indistinguishable from a small one.
  const oversized = oversizedInfo(payload);
  if (oversized) {
    context.stdin_truncated = true;
    context.stdin_bytes_read = oversized.bytesRead;
    context.stdin_max_bytes = oversized.maxBytes;
    // "prefix" — the cut happened to land on a boundary and parsed as-is;
    // "repaired" — reconstructed from the prefix; "none" — nothing survived,
    // and the ids below are "unknown".
    context.payload_fidelity = oversized.fidelity;
  }
  const lastUserPrompt = options.lastUserPrompt;
  if (
    config.includeLastUserPrompt &&
    typeof lastUserPrompt === "string" &&
    lastUserPrompt
  ) {
    context.last_user_prompt = truncatePromptString(
      config.redaction?.enabled
        ? redactStringSecrets(lastUserPrompt)
        : lastUserPrompt,
      config.maxContextBytes,
    );
  }

  return {
    subject: {
      type: "antigravity",
      // A subagent runs under its own conversationId with no parent field in
      // the payload, so it is a distinct subject by construction.
      id:
        typeof payload.conversationId === "string" && payload.conversationId
          ? payload.conversationId
          : "unknown",
      properties: {
        surface: options.surface || deriveSurface(payload, config.surface),
        workspace_paths: workspacePaths,
        cwd,
        step_idx: typeof payload.stepIdx === "number" ? payload.stepIdx : null,
        model_name:
          typeof payload.modelName === "string" && payload.modelName
            ? payload.modelName
            : "unknown",
      },
    },
    action: {
      // Stays "execute" for cross-extension policy parity; the inferred effect
      // rides in properties, matching Hermes.
      name: "execute",
      properties: {
        effect: inferEffect(toolName, args),
        tool_name: toolName,
      },
    },
    resource: {
      // Deliberately not Hermes' semantic resource rewriting: changing
      // resource.type would break policies written for the other extensions.
      type: "tool",
      id: toolName,
      properties: resourceProperties,
    },
    context,
  };
}

// "Reason-less" is a question about content, not truthiness: a reason the agent
// reads as blank is what pushes it into fabricating an answer (Step 0, §0.5
// item 7). Covers whitespace plus the invisibles JS `\s` does not — soft
// hyphen, zero-width space and joiners, the bidi marks, the word joiner.
const BLANK_REASON_PATTERN = /[\s\u00ad\u200b-\u200f\u2060\ufeff]/gu;

function hasReasonContent(value) {
  return typeof value === "string" && value.replace(BLANK_REASON_PATTERN, "") !== "";
}

// Maps a PDP response to a decision outcome without performing any I/O.
// Returns { kind: "allow" | "deny" | "error", reason }.
function interpretDecision(data) {
  const body = data && typeof data === "object" ? data : {};
  if (body.decision === true) {
    return {
      kind: "allow",
      reason: body.context?.reason ?? "",
    };
  }
  if (body.decision === false) {
    // Never reason-less. A reason with content is passed through byte-exact,
    // never trimmed — the PDP's wording is the agent's only explanation.
    const provided = body.context?.reason;
    return {
      kind: "deny",
      reason: hasReasonContent(provided)
        ? provided
        : "Authorization denied by Denied policy engine.",
    };
  }
  return {
    kind: "error",
    reason: "Unexpected PDP response: missing or invalid 'decision' field.",
  };
}

// Resolves a fail-safe outcome based on the configured fail mode.
// Returns { decision: "allow" | "deny" | "force_ask", reason }.
function resolveFailSafe(failMode, message) {
  const suffix = message ? ` ${message}` : "";
  if (failMode === "closed") {
    return {
      decision: "deny",
      reason: `Denied policy engine unavailable and fail-mode is closed.${suffix}`,
    };
  }
  if (failMode === "ask") {
    return {
      decision: "force_ask",
      reason: `Denied policy engine unavailable and fail-mode is ask.${suffix}`,
    };
  }
  return {
    decision: "allow",
    reason: `Denied policy engine unavailable and fail-mode is open.${suffix}`,
  };
}

// The emitted object, in one place. `{}` is not an allow on this platform — it
// denies — so a `decision` field is always present, and `reason` is included
// whenever there is one to give.
// The reason is capped here, at the single choke point every emission passes
// through: it can carry an upstream body (a proxy's HTML block page) or a PDP
// reason of any length, and an emitted object larger than the OS pipe buffer
// blocks the write forever on a host that reads stdout only after we exit. The
// cut keeps the head, which is the part that tells the agent why.
function buildDecisionOutput(decision, reason) {
  const output = { decision };
  if (hasReasonContent(reason)) {
    output.reason = truncatePromptString(reason, MAX_REASON_BYTES);
  }
  return output;
}

// ---------------------------------------------------------------------------
// I/O wrappers
// ---------------------------------------------------------------------------

// Synchronous by necessity: process.exit() discards pending asynchronous writes
// to a piped stderr. A closed or non-blocking stderr must never become a crash.
function writeStderr(message) {
  try {
    writeSync(STDERR_FD, message);
  } catch {
    /* nothing useful to do — the decision still has to be delivered */
  }
}

function warnStderr(message) {
  writeStderr(`[denied-dev] ${message}\n`);
}

// Writes the whole buffer, tolerating short writes and a non-blocking pipe.
// Returns the number of bytes actually delivered: the caller owns the
// remainder, and resending the whole text instead would put a fragment and a
// second complete decision object on stdout — an unparseable payload, which on
// this platform denies.
function writeAllSync(fd, buffer) {
  let offset = 0;
  const deadline = Date.now() + FLUSH_GRACE_MS;
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (err) {
      const retryable = err && (err.code === "EAGAIN" || err.code === "EWOULDBLOCK");
      if (!retryable || Date.now() >= deadline) {
        return offset;
      }
    }
  }
  return offset;
}

// Emit guard. Exported accessors exist so the double-emit invariant is testable
// without spawning a process.
//
// Two booleans could not express what the exit net has to know, and the gap
// between them was reachable in both directions. A short write set the "already
// emitted" flag while the remainder was still unwritten, so if the process
// exited before the async flush landed (the unref'd guard below, a signal) the
// net stayed disarmed and stdout carried a *fragment* — zero complete objects.
// And a writer that threw after part of the buffer was already on the wire left
// the flag false, so the net wrote a whole second object after the fragment —
// two objects, unparseable, which denies on this platform. So the state is the
// three states that actually exist:
//   IDLE    nothing has reached stdout — the net owes a whole object
//   ACTIVE  a writer is on the stack and has delivered nothing yet
//   PARTIAL bytes are on the wire and `pendingBytes` is the rest of them —
//           the net owes the *remainder*, never a new object
//   DONE    the object is fully delivered — the net owes nothing
const EMIT_IDLE = 0;
const EMIT_ACTIVE = 1;
const EMIT_PARTIAL = 2;
const EMIT_DONE = 3;

let emitPhase = EMIT_IDLE;
let pendingBytes = null;

function hasEmitted() {
  return emitPhase === EMIT_DONE;
}

function resetEmitState() {
  emitPhase = EMIT_IDLE;
  pendingBytes = null;
}

// Returns true when this call produced the emission, false when it was
// suppressed because a decision had already been written (or is being written).
function emitDecision(decision, reason, writer = writeStdout) {
  if (emitPhase !== EMIT_IDLE) {
    return false;
  }
  emitPhase = EMIT_ACTIVE;
  try {
    writer(JSON.stringify(buildDecisionOutput(decision, reason)));
  } catch (err) {
    // The writer records a partial delivery itself, so ACTIVE here means
    // nothing reached stdout: re-arm the net for a whole object.
    if (emitPhase === EMIT_ACTIVE) {
      emitPhase = EMIT_IDLE;
    }
    throw err;
  }
  if (emitPhase === EMIT_ACTIVE) {
    emitPhase = EMIT_DONE;
  }
  return true;
}

function writeStdout(text) {
  const buffer = Buffer.from(text, "utf-8");
  const written = writeAllSync(STDOUT_FD, buffer);
  if (written >= buffer.length) {
    return;
  }
  // stdout refused a synchronous write; send only what is left — resending the
  // whole text would duplicate the part already on the wire — and let the flush
  // callback own the exit instead of exiting under it. Until that callback
  // fires the state stays PARTIAL, which is what lets the exit handler finish
  // the write if anything ends the process first.
  pendingBytes = buffer.subarray(written);
  emitPhase = EMIT_PARTIAL;
  const done = () => {
    // Only the stream callback proves delivery.
    if (emitPhase === EMIT_PARTIAL) {
      pendingBytes = null;
      emitPhase = EMIT_DONE;
    }
    process.exit(0);
  };
  // The guard deliberately does *not* call done(): if the flush has not landed
  // by now it has not been delivered, so it exits with the state still PARTIAL
  // and lets the exit handler push the remainder out synchronously.
  const guard = setTimeout(() => process.exit(0), FLUSH_GRACE_MS);
  if (typeof guard.unref === "function") {
    guard.unref();
  }
  try {
    process.stdout.write(pendingBytes, done);
  } catch {
    process.exit(0); // same reasoning as the guard
  }
}

// The only place this process is allowed to terminate, and it always exits 0:
// exit-code semantics are the host's most unstable surface, so the decision
// object on stdout is the entire protocol.
function emitAndExit(decision, reason) {
  try {
    emitDecision(decision, reason);
  } catch (err) {
    // Losing the decision is the one unrecoverable outcome; say so on stderr.
    writeStderr(
      `[denied-dev] Failed to emit decision: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  if (emitPhase === EMIT_PARTIAL) {
    return; // the write callback (or its guard) owns the exit
  }
  process.exit(0);
}

function failSafeExit(message, config = activeConfig) {
  warnStderr(message);
  const outcome = resolveFailSafe(config.failMode, message);
  emitAndExit(outcome.decision, outcome.reason);
}

// Writes the decision to stdout, and only then attempts the audit record. The
// ordering is the load-bearing part, not an optimisation: a blocked audit sink
// blocks in open(2) inside the libuv threadpool, and a process with a stuck
// threadpool thread cannot be terminated at all — measured on Node 26 / macOS,
// neither process.exit(0) nor process.reallyExit(0) returns, so the watchdog
// cannot save it either and the host reaps it at its own timeout. What *does*
// survive that is anything already written to stdout. So the decision goes out
// first and the audit is attempted afterwards, under its own deadline: the
// worst case degrades from "the host picks the outcome" to "the record is
// missing".
async function emitThenAudit(decision, reason, input, body, record, config) {
  try {
    emitDecision(decision, reason);
  } catch (err) {
    writeStderr(
      `[denied-dev] Failed to emit decision: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  await appendAuditRecord(input, body, record, config);
  if (emitPhase === EMIT_PARTIAL) {
    return; // the write callback (or its guard) owns the exit
  }
  process.exit(0);
}

async function failSafeAudit(message, input, body, record, config) {
  warnStderr(message);
  const outcome = resolveFailSafe(config.failMode, message);
  await emitThenAudit(outcome.decision, outcome.reason, input, body, record, config);
}

const AUDIT_TIMED_OUT = Symbol("audit-timed-out");

// Audit is observability, never a gate on the decision — and "never a gate"
// has to include *time*. This is awaited on the decision path, ahead of the
// deny/allow emit, and neither fs.mkdir nor fs.appendFile has a deadline of its
// own; on a wedged or full filesystem (NFS, FUSE, a full disk) the watchdog
// still fired, so exit 0 and the one-object invariant held, but a real deny had
// already been replaced by the failMode outcome — silently an *allow* under the
// default failMode: open. So the write is raced against its own deadline the
// same way the config read is, and the deadline sits inside BUDGET_SLACK_MS.
// The write promise keeps its own .catch, so a rejection arriving after the
// race is handled rather than becoming an unhandledRejection.
async function appendAuditRecord(
  input,
  body,
  decision,
  config = DEFAULT_CONFIG,
  timeoutMs = DEFAULT_AUDIT_TIMEOUT_MS,
) {
  if (!config.audit?.enabled) {
    return;
  }

  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(AUDIT_TIMED_OUT);
    }, timeoutMs);
  });

  const write = (async () => {
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
      path.join(config.audit.dir, "denied-antigravity-hook.jsonl"),
      `${JSON.stringify(record)}\n`,
      { encoding: "utf-8", signal: controller.signal },
    );
  })().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    warnStderr(`Failed to write audit record: ${message}`);
  });

  try {
    if ((await Promise.race([write, deadline])) === AUDIT_TIMED_OUT) {
      warnStderr(
        `Audit write did not complete within ${timeoutMs}ms; abandoning the record rather than delaying the decision.`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Read stdin (Antigravity streams the hook context as JSON, and may not close)
// ---------------------------------------------------------------------------

// Never throws, never outlives its deadline, and never exceeds its byte
// ceiling: whatever arrived (or nothing) becomes a payload object and the check
// proceeds. The two bounds are independent — time alone left every downstream
// synchronous stage unbounded (see MAX_STDIN_BYTES).
//
// Stopping early closes stdin under a host that is still writing. That is the
// deliberate trade: the alternative is buffering a payload we have already
// decided not to send. Everything up to the ceiling is kept and repaired, so
// the check still goes out.
async function readStdin(
  stream = process.stdin,
  timeoutMs = DEFAULT_STDIN_TIMEOUT_MS,
  maxBytes = MAX_STDIN_BYTES,
) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  const timer = setTimeout(() => stream.destroy(), timeoutMs);
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (size + buffer.length > maxBytes) {
        chunks.push(buffer.subarray(0, maxBytes - size));
        size = maxBytes;
        overflow = true;
        break; // breaking destroys the stream and releases the pipe
      }
      chunks.push(buffer);
      size += buffer.length;
    }
  } catch {
    /* destroyed by the deadline, or unreadable — fall through to what we have */
  } finally {
    clearTimeout(timer);
  }

  const text = Buffer.concat(chunks).toString("utf-8");
  if (!overflow) {
    return parseHookPayload(text);
  }

  // A cut document almost never parses, so the prefix is repaired rather than
  // dropped: an oversized payload is not a reason to stop asking the PDP, and
  // the tool name and conversation id both sit near the front of it.
  let payload = parseHookPayload(text);
  let fidelity = Object.keys(payload).length ? "prefix" : "none";
  if (fidelity === "none") {
    const repaired = repairTruncatedJson(text);
    if (repaired && Object.keys(repaired).length) {
      payload = repaired;
      fidelity = "repaired";
    }
  }
  warnStderr(
    `Hook payload exceeded ${maxBytes} bytes; truncated at the ceiling and sending the check with a ${fidelity} payload.`,
  );
  return markOversized(payload, {
    bytesRead: size,
    maxBytes,
    fidelity,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Bounds the inbound body. `res.json()` / `res.text()` buffer whatever the far
// end sends, and a large enough body is an out-of-memory abort: SIGABRT is not
// catchable by uncaughtException, so the process dies with empty stdout and the
// host picks the outcome. Overflow is reported, never silently truncated into a
// decision, because a cut JSON body is not the PDP's answer.
async function readBoundedBody(res, maxBytes = MAX_RESPONSE_BYTES) {
  const body = res.body;
  if (!body || typeof body[Symbol.asyncIterator] !== "function") {
    const text = await res.text();
    const bytes = Buffer.byteLength(text, "utf-8");
    return { text: truncateUtf8(text, maxBytes), overflow: bytes > maxBytes };
  }
  const chunks = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk);
    if (size + buffer.length > maxBytes) {
      chunks.push(buffer.subarray(0, maxBytes - size));
      overflow = true;
      break; // breaking cancels the stream and releases the socket
    }
    chunks.push(buffer);
    size += buffer.length;
  }
  return { text: Buffer.concat(chunks).toString("utf-8"), overflow };
}

async function main() {
  // The two reads are independent, so they run concurrently: sequenced, a
  // stalled config file would spend the stdin budget as well and push the
  // decision into the watchdog. activeConfig is replaced the moment the config
  // resolves, so the fatal handlers and the watchdog stop holding the env-only
  // default at the earliest possible point.
  const configPromise = loadRuntimeConfig().then((resolved) => {
    activeConfig = resolved;
    return resolved;
  });
  // stdin is drained before any early exit so the host never writes into a
  // closed pipe on the missing-API-key path — up to MAX_STDIN_BYTES, past which
  // the pipe is closed deliberately (see readStdin).
  const [config, input] = await Promise.all([configPromise, readStdin()]);

  if (!config.apiKey) {
    failSafeExit(
      'No API key found. Set DENIED_API_KEY or add "apiKey" to ~/.denied/config.json. Skipping authorization check.',
      config,
    );
    return;
  }

  let lastUserPrompt = null;
  if (config.includeLastUserPrompt) {
    lastUserPrompt = await readLastUserPrompt(
      resolveTranscriptPath(
        input.transcriptPath,
        workspacePathList(input),
        process.cwd(),
      ),
    );
  }

  const body = buildCheckBody(input, config, { lastUserPrompt });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const res = await fetch(`${config.url}/pdp/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      // A corporate proxy answers a blocked request with a whole HTML page, so
      // the body is bounded on the way in and again on the way into the reason.
      const { text } = await readBoundedBody(res);
      const error = {
        error: `HTTP ${res.status}: ${truncatePromptString(text, MAX_REASON_BYTES)}`,
      };
      await failSafeAudit(error.error, input, body, error, config);
      return;
    }

    let data;
    try {
      const { text, overflow } = await readBoundedBody(res);
      if (overflow) {
        throw new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
      data = JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failSafeAudit(
        `PDP response was not valid JSON: ${message}`,
        input,
        body,
        { error: message },
        config,
      );
      return;
    }

    const outcome = interpretDecision(data);

    if (outcome.kind === "allow") {
      await emitThenAudit("allow", "", input, body, data, config);
      return;
    }
    if (outcome.kind === "deny") {
      warnStderr(`Blocked tool call: ${body.resource.id}`);
      warnStderr(outcome.reason);
      await emitThenAudit("deny", outcome.reason, input, body, data, config);
      return;
    }
    await failSafeAudit(outcome.reason, input, body, data, config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failSafeAudit(
      `Failed to reach Denied PDP: ${message}`,
      input,
      body,
      { error: message },
      config,
    );
  } finally {
    clearTimeout(timer);
  }
}

// Nothing below runs on require: no timers armed, no stdin read, no process
// handlers installed, so the module is safe to import from a test file.
if (require.main === module) {
  const onFatal = (err) =>
    failSafeExit(
      `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  // Signal death is a normal way for this process to end — the host kills the
  // child at its own timeout, Ctrl-C reaches the whole process group, closing
  // the IDE sends SIGHUP — and it bypasses the exit handler below entirely,
  // leaving empty stdout and the outcome to the host. SIGKILL and SIGSTOP
  // cannot be caught; every other signal ends in a decision and exit 0.
  //
  // With one structural caveat, which the watchdog below shares: a handler is
  // an event-loop callback and cannot preempt synchronous work. A signal (or a
  // watchdog expiry) arriving during a long synchronous burst is queued, not
  // handled, and the host's own timeout wins. That is why every synchronous
  // stage on the decision path is bounded by *size* rather than by time —
  // MAX_STDIN_BYTES on the payload, MAX_TOOL_NAME_BYTES on the name matched
  // against NAME_EFFECT_PATTERNS, MAX_REDACT_STRING_BYTES on each redacted
  // string — and why every pattern in this file must be linear in its input.
  // Those bounds, not these handlers, are what makes the claim above true.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) {
    process.on(signal, () =>
      failSafeExit(`Received ${signal} before a decision was made.`),
    );
  }
  // Node ignores SIGPIPE by default; the listener makes that explicit. There is
  // nothing to deliver once stdout's reader is gone, so the write path fails on
  // its own rather than the process dying mid-decision.
  process.on("SIGPIPE", () => {});
  // Last resort: if the process somehow reaches exit without a decision, the
  // host would choose the outcome — which is the one thing never permitted.
  // Which debt is owed depends on the emit state: a half-written object is
  // *finished*, never restarted, because a second complete object after a
  // fragment is exactly as unparseable as the fragment alone.
  process.on("exit", () => {
    if (emitPhase === EMIT_DONE) {
      return;
    }
    if (emitPhase === EMIT_PARTIAL && pendingBytes && pendingBytes.length) {
      const remainder = pendingBytes;
      pendingBytes = null;
      emitPhase = EMIT_DONE;
      if (writeAllSync(STDOUT_FD, remainder) < remainder.length) {
        writeStderr("[denied-dev] Failed to flush the rest of the decision.\n");
      }
      return;
    }
    emitPhase = EMIT_DONE;
    const outcome = resolveFailSafe(
      activeConfig.failMode,
      "Interceptor exited without a decision.",
    );
    const payload = Buffer.from(
      JSON.stringify(buildDecisionOutput(outcome.decision, outcome.reason)),
      "utf-8",
    );
    if (writeAllSync(STDOUT_FD, payload) < payload.length) {
      // No async fallback is possible under `exit`; say so rather than let a
      // partial object look like a decision.
      writeStderr("[denied-dev] Failed to flush the fail-safe decision.\n");
    }
  });
  // Deliberately not unref'd: keeping the event loop alive means the process
  // cannot fall off the end before a decision is written.
  setTimeout(() => {
    failSafeExit(
      `Watchdog fired after ${WATCHDOG_MS}ms; emitting the configured fail-safe decision.`,
    );
  }, WATCHDOG_MS);
  main().then(() => {
    if (!hasEmitted()) {
      failSafeExit("Interceptor finished without emitting a decision.");
    }
  }, onFatal);
}

module.exports = {
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
  hasReasonContent,
  extractLastUserPrompt,
  readLastUserPrompt,
  appendAuditRecord,
  readStdin,
  readBoundedBody,
  emitDecision,
  hasEmitted,
  resetEmitState,
  main,
};
