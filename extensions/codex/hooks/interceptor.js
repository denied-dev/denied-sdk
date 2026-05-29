// Denied SDK – Codex CLI PreToolUse interceptor
// Zero dependencies. Requires Node.js 18+ (native fetch).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_URL = "https://api.denied.dev";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FAIL_MODE = "open"; // "open" | "closed"

// Codex spawns hooks with the `codex` process environment, NOT the interactive
// shell environment — so `export DENIED_API_KEY=...` in a terminal is often
// invisible to the hook. To make this work without depending on shell setup,
// settings are resolved from (in order): environment variables, then a JSON
// config file (~/.denied/config.json, override with DENIED_CONFIG), then
// built-in defaults. Environment variables always win when present.

function resolveConfigPath(env, homedir) {
  if (env.DENIED_CONFIG) {
    return env.DENIED_CONFIG;
  }
  return path.join(homedir, ".denied", "config.json");
}

// Reads and parses the JSON config file. Returns {} when missing or invalid;
// surfaces a malformed-file warning so silent misconfiguration is debuggable.
function loadFileConfig(configPath, warn = () => {}) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
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

  return {
    url: env.DENIED_URL || fileConfig.url || DEFAULT_URL,
    apiKey: env.DENIED_API_KEY || fileConfig.apiKey || "",
    failMode: (
      env.DENIED_FAIL_MODE ||
      fileConfig.failMode ||
      DEFAULT_FAIL_MODE
    ).toLowerCase(),
    timeoutMs,
  };
}

const CONFIG = resolveConfig(
  process.env,
  loadFileConfig(
    resolveConfigPath(process.env, os.homedir()),
    (message) => process.stderr.write(`[denied-dev] ${message}\n`),
  ),
);

// ---------------------------------------------------------------------------
// Pure logic (exported for unit testing)
// ---------------------------------------------------------------------------

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

function buildCheckBody(input) {
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
      properties: {
        tool_input: input.tool_input || {},
        tool_use_id: input.tool_use_id || "unknown",
      },
    },
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

function failSafe(message) {
  process.stderr.write(`[denied-dev] ${message}\n`);
  const outcome = resolveFailSafe(CONFIG.failMode, message);
  if (outcome.kind === "deny") {
    deny(outcome.reason);
  } else {
    allow(outcome.reason);
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
  if (!CONFIG.apiKey) {
    failSafe(
      "No API key found. Set DENIED_API_KEY or add \"apiKey\" to ~/.denied/config.json. Skipping authorization check.",
    );
    return;
  }

  let input;
  try {
    input = await readStdin();
  } catch {
    failSafe("Failed to parse hook stdin.");
    return;
  }

  const body = buildCheckBody(input);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);

  try {
    const headers = {
      "Content-Type": "application/json",
      "X-API-Key": CONFIG.apiKey,
    };

    const res = await fetch(`${CONFIG.url}/pdp/check`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      failSafe(`HTTP ${res.status}: ${await res.text()}`);
      return;
    }

    const data = await res.json();
    const outcome = interpretDecision(data);

    if (outcome.kind === "allow") {
      allow(outcome.reason);
    } else if (outcome.kind === "deny") {
      process.stderr.write(
        `[denied-dev] Blocked tool call: ${input.tool_name}\n`,
      );
      deny(outcome.reason);
    } else {
      failSafe(outcome.reason);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failSafe(`Failed to reach Denied PDP: ${message}`);
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
  resolveConfig,
  buildCheckBody,
  interpretDecision,
  resolveFailSafe,
  buildDenyOutput,
  main,
};
