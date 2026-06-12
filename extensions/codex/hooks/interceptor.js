// Denied SDK – Codex CLI PreToolUse interceptor
// Zero dependencies. Requires Node.js 18+ (native fetch).

const fs = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");

const DEFAULT_URL = "https://api.denied.dev";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FAIL_MODE = "open"; // "open" | "closed"
const DEFAULT_CONTEXT_MAX_BYTES = 20_000;

// Codex's own config file (config.toml) offers no way to set environment
// variables for hooks, so an `export` is the only env option and it lasts only
// for the current shell session. To allow a persistent setup, settings are
// resolved from (in order): environment variables, then a JSON config file
// (~/.denied/config.json, override with DENIED_CONFIG), then built-in defaults.
// Environment variables always win when present.


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

// Merges env vars (highest precedence), file config, and defaults into the
// resolved settings. Pure function — no I/O — for unit testing.
function resolveConfig(env, fileConfig) {
  const timeoutFromEnv = parseInt(env.DENIED_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isFinite(timeoutFromEnv)
    ? timeoutFromEnv
    : Number.isFinite(fileConfig.timeoutMs)
      ? fileConfig.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const requestConfig =
    fileConfig.request && typeof fileConfig.request === "object"
      ? fileConfig.request
      : {};
  const auditConfig =
    fileConfig.audit && typeof fileConfig.audit === "object"
      ? fileConfig.audit
      : {};
  const maxContextBytes = positiveInteger(
    requestConfig.maxContextBytes,
    DEFAULT_CONTEXT_MAX_BYTES,
  );

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
    maxContextBytes,
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

// Builds the AuthZEN evaluation request body from the Codex hook input.

//   Common input fields:
//     session_id: Current Codex session id. Subagent hooks use the parent session id.
//     transcript_path: Path to the session transcript file, if any
//     cwd: Working directory for the session
//     hook_event_name: Current hook event name
//     model: Codex-specific extension. Active model slug
//     permission_mode: Current permission mode as `default`, `acceptEdits`, `plan`, `dontAsk`, or `bypassPermissions`
//   PreToolUse specific input fields:
//     turn_id: Codex-specific extension. Active Codex turn id
//     tool_name: Canonical hook tool name, such as `Bash`, `apply_patch`, or an MCP name like `mcp__fs__read`
//     tool_use_id: Tool-call id for this invocation
//     tool_input: Tool-specific input. `Bash` and `apply_patch` use `tool_input.command` while MCP tools send all arguments.

function buildCheckBody(input, config = DEFAULT_CONFIG) {
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
    integration: "denied-codex-hook",
    hook_event_name: input.hook_event_name,
    authz_direction: "agent-to-world",
  };
  if (config.includeHookPayload) {
    context.hook_payload = truncateJsonValue(input, config.maxContextBytes);
  }

  return {
    subject: {
      type: "codex",
      id: input.session_id ?? "unknown",
      properties: {
        cwd: input.cwd ?? "unknown",
        permission_mode: input.permission_mode ?? "unknown",
        model: input.model ?? "unknown",
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

// Builds the stdout payload Codex expects for a deny decision.
function buildDenyOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

// ---------------------------------------------------------------------------
// I/O wrappers
// ---------------------------------------------------------------------------

function allow(_reason) {
  // Codex CLI rejects `permissionDecision: "allow"` from PreToolUse hooks
  // (parses but doesn't support it; raises "unsupported permissionDecision:allow").
  // Per Codex hook docs, exit 0 with no stdout output means "continue normally".
}

function deny(reason) {
  process.stdout.write(JSON.stringify(buildDenyOutput(reason)));
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
      path.join(config.audit.dir, "denied-codex-hook.jsonl"),
      `${JSON.stringify(record)}\n`,
      "utf-8",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[denied-dev] Failed to write audit record: ${message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Read stdin (Codex streams the hook context as JSON)
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
    failSafe(
      "No API key found. Set DENIED_API_KEY or add \"apiKey\" to ~/.denied/config.json. Skipping authorization check.",
      config,
    );
    return;
  }

  let input;
  try {
    input = await readStdin();
  } catch {
    failSafe("Failed to parse hook stdin.", config);
    return;
  }

  const body = buildCheckBody(input, config);

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
  } finally {
    clearTimeout(timer);
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
  buildCheckBody,
  appendAuditRecord,
  interpretDecision,
  resolveFailSafe,
  buildDenyOutput,
  main,
};
