// Tests for the Codex interceptor pure logic.
// Run with: node --test (Node 18+, zero dependencies).

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCheckBody,
  interpretDecision,
  resolveFailSafe,
  buildDenyOutput,
} = require("./interceptor.js");

test("buildCheckBody maps a full input to an AuthZEN request", () => {
  const body = buildCheckBody({
    session_id: "sess-1",
    cwd: "/work",
    permission_mode: "ask",
    model: "gpt-5-codex",
    tool_name: "shell",
    tool_input: { command: "ls" },
    tool_use_id: "use-1",
  });

  assert.deepEqual(body, {
    subject: {
      type: "codex",
      id: "sess-1",
      properties: {
        cwd: "/work",
        permission_mode: "ask",
        model: "gpt-5-codex",
      },
    },
    action: { name: "execute" },
    resource: {
      type: "tool",
      id: "shell",
      properties: {
        tool_input: { command: "ls" },
        tool_use_id: "use-1",
      },
    },
  });
});

test("buildCheckBody fills defaults for missing fields", () => {
  const body = buildCheckBody({});

  assert.equal(body.subject.type, "codex");
  assert.equal(body.subject.id, "unknown");
  assert.equal(body.subject.properties.cwd, "unknown");
  assert.equal(body.subject.properties.permission_mode, "unknown");
  assert.equal(body.subject.properties.model, "unknown");
  assert.equal(body.resource.id, "unknown");
  assert.deepEqual(body.resource.properties.tool_input, {});
  assert.equal(body.resource.properties.tool_use_id, "unknown");
});

test("interpretDecision allows on decision === true", () => {
  assert.deepEqual(interpretDecision({ decision: true }), {
    kind: "allow",
    reason: "Authorization allowed by Denied policy engine.",
  });
});

test("interpretDecision denies on decision === false", () => {
  assert.deepEqual(interpretDecision({ decision: false }), {
    kind: "deny",
    reason: "Authorization denied by Denied policy engine.",
  });
});

test("interpretDecision prefers the context reason when present", () => {
  assert.equal(
    interpretDecision({ decision: false, context: { reason: "blocked: rm" } })
      .reason,
    "blocked: rm",
  );
  assert.equal(
    interpretDecision({ decision: true, context: { reason: "ok: read" } })
      .reason,
    "ok: read",
  );
});

test("interpretDecision errors on a missing or non-boolean decision", () => {
  assert.equal(interpretDecision({}).kind, "error");
  assert.equal(interpretDecision({ decision: "yes" }).kind, "error");
  assert.equal(interpretDecision({ decision: null }).kind, "error");
});

test("resolveFailSafe denies when fail mode is closed", () => {
  const outcome = resolveFailSafe("closed", "boom");
  assert.equal(outcome.kind, "deny");
  assert.match(outcome.reason, /fail-mode is closed\. boom/);
});

test("resolveFailSafe allows for open or any non-closed mode", () => {
  assert.equal(resolveFailSafe("open", "boom").kind, "allow");
  assert.equal(resolveFailSafe("whatever", "boom").kind, "allow");
});

test("buildDenyOutput shapes the Codex PreToolUse payload", () => {
  assert.deepEqual(buildDenyOutput("nope"), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "nope",
    },
  });
});
