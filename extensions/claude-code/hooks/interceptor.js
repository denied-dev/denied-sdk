// Denied SDK – Claude Code PreToolUse interceptor
// Zero dependencies. Requires Node.js 18+ (native fetch).

const fs = require("node:fs").promises;
const { createReadStream } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_URL = "https://api.denied.dev";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FAIL_MODE = "open"; // "open" | "closed"
const DEFAULT_CONTEXT_MAX_BYTES = 20_000;
const DEFAULT_TAIL_BYTES = 65_536; // 64 KB tail window for the transcript read
const DEFAULT_READ_TIMEOUT_MS = 1_000; // independent deadline for the transcript read

function resolveConfigPath(env, homedir) {
  if (env.DENIED_CONFIG) {
    return env.DENIED_CONFIG;
  }
  return path.join(homedir, ".denied", "config.json");
}

async function loadFileConfig(configPath, warn = () => { }) {
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

function positiveInteger(value, fallback) {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function expandHome(value, homedir) {
  return value === "~" || value.startsWith("~/")
    ? path.join(homedir, value.slice(2))
    : value;
}

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
  const auditConfig =
    fileConfig.audit && typeof fileConfig.audit === "object"
      ? fileConfig.audit
      : {};

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
    includeLastUserPrompt: requestConfig.includeLastUserPrompt !== false,
    maxContextBytes: positiveInteger(
      requestConfig.maxContextBytes,
      DEFAULT_CONTEXT_MAX_BYTES,
    ),
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
  warn = (message) => process.stderr.write(`[denied-dev] ${message}\n`),
) {
  const fileConfig = await loadFileConfig(resolveConfigPath(env, homedir), warn);
  return resolveConfig(env, fileConfig);
}

const DEFAULT_CONFIG = resolveConfig(process.env, {});

// ---------------------------------------------------------------------------
// Pure logic (exported for unit testing)
// ---------------------------------------------------------------------------

// Builds the AuthZEN evaluation request body from the Claude Code hook input.

//   Common input fields:
//     session_id: Current session identifier
//     transcript_path: Path to conversation JSON
//     cwd: Current working directory when the hook is invoked
//     permission_mode: Current permission mode: "default", "plan", "acceptEdits", "auto", "dontAsk", or "bypassPermissions"
//     effort: Object with a level field holding the active effort level for the turn: "low", "medium", "high", "xhigh", or "max"
//     hook_event_name: Name of the event that fired
//   PreToolUse specific input fields:
//     tool_name
//     tool_input
//     tool_use_id

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

// Truncates a prompt while keeping the field a plain string (unlike
// truncateJsonValue, which returns an object for oversized values). An inline
// marker signals truncation so the value stays self-describing.
function truncatePromptString(value, maxBytes) {
  const bytes = Buffer.byteLength(value, "utf-8");
  if (bytes <= maxBytes) {
    return value;
  }
  const marker = ` … [truncated ${bytes} bytes]`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf-8"));
  return truncateUtf8(value, budget) + marker;
}

// Scans a transcript tail (newest content last) for the most recent
// Claude Code `last-prompt` entry and returns its plain-string prompt.
// Pure: no I/O. Returns null when no usable marker is found.
function extractLastUserPrompt(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    let obj;
    try {
      // A mid-file tail window often starts with a partial line that fails
      // to parse; we simply skip those and keep scanning backwards.
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      obj &&
      obj.type === "last-prompt" &&
      typeof obj.lastPrompt === "string"
    ) {
      return obj.lastPrompt;
    }
  }
  return null;
}

function buildCheckBody(input, config = DEFAULT_CONFIG, lastUserPrompt = null) {
  const toolInput =
    input.tool_input && typeof input.tool_input === "object"
      ? input.tool_input
      : {};
  const properties = {
    tool_use_id: input.tool_use_id || "unknown",
  };
  if (config.includeToolInput) {
    properties.tool_input = truncateJsonValue(toolInput, config.maxContextBytes);
  }

  const context = {
    integration: "denied-claude-code-hook",
    hook_event_name: input.hook_event_name,
    authz_direction: "agent-to-world",
  };
  if (config.includeHookPayload) {
    context.hook_payload = truncateJsonValue(input, config.maxContextBytes);
  }
  if (config.includeLastUserPrompt && typeof lastUserPrompt === "string" && lastUserPrompt) {
    context.last_user_prompt = truncatePromptString(
      lastUserPrompt,
      config.maxContextBytes,
    );
  }

  return {
    subject: {
      type: "claude-code",
      id: input.session_id ?? "unknown",
      properties: {
        cwd: input.cwd ?? "unknown",
        permission_mode: input.permission_mode ?? "unknown",
      },
    },
    action: {
      name: "execute",
    },
    resource: {
      type: "tool",
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

// Builds the stdout payload Claude Code expects for a permission decision.
// Claude Code supports both "allow" and "deny" (unlike Codex, which only denies).
function buildDecisionOutput(permissionDecision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason,
    },
  };
}

// ---------------------------------------------------------------------------
// I/O wrappers
// ---------------------------------------------------------------------------

function allow(reason) {
  process.stdout.write(JSON.stringify(buildDecisionOutput("allow", reason)));
}

function deny(reason) {
  process.stdout.write(JSON.stringify(buildDecisionOutput("deny", reason)));
}

function failSafe(message, config = DEFAULT_CONFIG) {
  process.stderr.write(`[denied-dev] ${message}\n`);
  const outcome = resolveFailSafe(config.failMode, message);
  if (outcome.kind === "deny") {
    deny(outcome.reason);
  } else {
    allow(outcome.reason);
  }
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
      record.hook_payload = truncateJsonValue(input, config.maxContextBytes);
    }
    if (config.audit.includeMappedRequest) {
      record.mapped_request = truncateJsonValue(body, config.maxContextBytes);
    }
    if (config.audit.includeDecision) {
      record.decision = truncateJsonValue(decision, config.maxContextBytes);
    }
    await fs.appendFile(
      path.join(config.audit.dir, "denied-claude-code-hook.jsonl"),
      `${JSON.stringify(record)}\n`,
      "utf-8",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[denied-dev] Failed to write audit record: ${message}\n`);
  }
}

// Reads a bounded tail (Strategy B) of the session transcript and returns the
// most recent user prompt, or null. Best-effort: any missing file, read error,
// or absent marker resolves to null so the authorization decision is never
// delayed or failed.
async function readLastUserPrompt(
  transcriptPath,
  maxTailBytes = DEFAULT_TAIL_BYTES,
  readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
) {
  if (!transcriptPath) {
    return null;
  }
  // The read has its own independent deadline (separate from the PDP fetch
  // timeout). The signal is passed to the stream so a stalled device aborts
  // the in-flight read rather than blocking the authorization decision.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), readTimeoutMs);
  try {
    const { size } = await fs.stat(transcriptPath);
    if (size === 0) {
      return null;
    }
    const start = Math.max(0, size - maxTailBytes);
    const stream = createReadStream(transcriptPath, {
      start,
      end: size - 1,
      signal: controller.signal,
    });
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return extractLastUserPrompt(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Read stdin (Claude Code streams the hook context as JSON)
// ---------------------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = await loadRuntimeConfig();

  if (!config.apiKey) {
    failSafe("DENIED_API_KEY is not set. Skipping authorization check.", config);
    return;
  }

  let input;
  try {
    input = await readStdin();
  } catch {
    failSafe("Failed to parse hook stdin.", config);
    return;
  }

  let lastUserPrompt = null;
  if (config.includeLastUserPrompt) {
    lastUserPrompt = await readLastUserPrompt(input.transcript_path);
  }

  const body = buildCheckBody(input, config, lastUserPrompt);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

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

    clearTimeout(timer);

    if (!res.ok) {
      const error = { error: `HTTP ${res.status}: ${await res.text()}` };
      await appendAuditRecord(input, body, error, config);
      failSafe(error.error, config);
      return;
    }

    const data = await res.json();
    await appendAuditRecord(input, body, data, config);
    const outcome = interpretDecision(data);

    if (outcome.kind === "allow") {
      allow(outcome.reason);
    } else if (outcome.kind === "deny") {
      process.stderr.write(
        `[denied-dev] Blocked tool call: ${input.tool_name}\n`,
      );
      deny(outcome.reason);
    } else {
      failSafe(outcome.reason, config);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendAuditRecord(input, body, { error: message }, config);
    failSafe(`Failed to reach Denied PDP: ${message}`, config);
  }
}

if (require.main === module) {
  main().catch((err) => {
    failSafe(
      `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

module.exports = {
  resolveConfigPath,
  loadFileConfig,
  loadRuntimeConfig,
  resolveConfig,
  truncateJsonValue,
  extractLastUserPrompt,
  readLastUserPrompt,
  buildCheckBody,
  appendAuditRecord,
  interpretDecision,
  resolveFailSafe,
  buildDecisionOutput,
  main,
};
