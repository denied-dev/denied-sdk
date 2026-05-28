// Denied SDK – Claude Code PreToolUse interceptor
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

function buildCheckBody(input) {
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
  buildDecisionOutput,
  main,
};
