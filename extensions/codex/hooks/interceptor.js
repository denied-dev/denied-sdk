// Denied SDK – Codex CLI PreToolUse interceptor
// Zero dependencies. Requires Node.js 18+ (native fetch).

const DENIED_URL = process.env.DENIED_URL || "https://api.denied.dev";
const DENIED_API_KEY = process.env.DENIED_API_KEY || "";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FAIL_MODE = "open"; // "open" | "closed"

const timeoutFromEnv = parseInt(process.env.DENIED_TIMEOUT_MS ?? "");
const TIMEOUT_MS = Number.isFinite(timeoutFromEnv)
  ? timeoutFromEnv
  : DEFAULT_TIMEOUT_MS;
const FAIL_MODE = (
  process.env.DENIED_FAIL_MODE || DEFAULT_FAIL_MODE
).toLowerCase();

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
  const outcome = resolveFailSafe(FAIL_MODE, message);
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
  if (!DENIED_API_KEY) {
    failSafe("DENIED_API_KEY is not set. Skipping authorization check.");
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

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const headers = {
      "Content-Type": "application/json",
      "X-API-Key": DENIED_API_KEY,
    };

    const res = await fetch(`${DENIED_URL}/pdp/check`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

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
  buildCheckBody,
  interpretDecision,
  resolveFailSafe,
  buildDenyOutput,
  main,
};
