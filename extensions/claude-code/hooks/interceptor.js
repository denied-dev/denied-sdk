// Denied SDK – Claude Code PreToolUse interceptor
// Zero dependencies. Requires Node.js 18+ (native fetch).

const DENIED_URL = process.env.DENIED_URL || "https://api.denied.dev";
const DENIED_API_KEY = process.env.DENIED_API_KEY || "";
const FAIL_MODE = (process.env.DENIED_FAIL_MODE || "open").toLowerCase(); // "open" | "closed"
const TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allow(reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function deny(reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function failSafe(message) {
  process.stderr.write(`[denied-dev] ${message}\n`);
  if (FAIL_MODE === "closed") {
    deny(
      `Denied policy engine unavailable and fail-mode is closed. ${message}`,
    );
  } else {
    allow(`Denied policy engine unavailable and fail-mode is open. ${message}`);
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

  // Build AuthZEN evaluation request

  // Common input fields:
  //  session_id: Current session identifier
  //  transcript_path: Path to conversation JSON
  //  cwd: Current working directory when the hook is invoked
  //  permission_mode: Current permission mode: "default", "plan", "acceptEdits", "dontAsk", or "bypassPermissions"
  //  hook_event_name: Name of the event that fired
  // PreToolUse specific input fields:
  //  tool_name
  //  tool_input
  //  tool_use_id

  const body = {
    subject: {
      type: "claude-code",
      id: input.session_id ?? "unknown",
      properties: {
        cwd: input.cwd,
        permission_mode: input.permission_mode,
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

    if (data.decision === true) {
      const reason =
        data.context?.reason ??
        "Authorization allowed by Denied policy engine.";
      allow(reason);
    } else {
      const reason =
        data.context?.reason ?? "Authorization denied by Denied policy engine.";
      process.stderr.write(
        `[denied-dev] Blocked tool call: ${input.tool_name}\n`,
      );
      deny(reason);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failSafe(`Failed to reach Denied PDP: ${message}`);
  }
}

main();
