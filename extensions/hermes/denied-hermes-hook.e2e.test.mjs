import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { main } = require("./denied-hermes-hook.js");

async function runHook(payload, env, fetchResult, config) {
  let stdout = "";
  let stderr = "";
  const requests = [];
  let configPath;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "denied-hermes-home-"));
  const fetchMock = async (url, init = {}) => {
    if (fetchResult instanceof Error) {
      throw fetchResult;
    }

    requests.push({
      url: String(url),
      method: init.method,
      headers: init.headers,
      body:
        typeof init.body === "string" && init.body
          ? JSON.parse(init.body)
          : init.body,
    });

    const status = fetchResult?.status || 200;
    const body = fetchResult?.body || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  };

  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const originalFetch = globalThis.fetch;
  if (config) {
    configPath = path.join(
      os.tmpdir(),
      `denied-hermes-config-${process.pid}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}.json`,
    );
    await fs.writeFile(configPath, JSON.stringify(config), "utf-8");
  }

  const envValues = {
    HOME: tempHome,
    ...env,
    ...(config ? { DENIED_CONFIG: configPath, DENIED_HERMES_CONFIG: configPath } : {}),
  };
  const originalEnvValues = Object.fromEntries(
    Object.keys(envValues).map((key) => [key, process.env[key]]),
  );
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });

  try {
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: Readable.from([Buffer.from(JSON.stringify(payload))]),
    });
    Object.assign(process.env, envValues);
    globalThis.fetch = fetchMock;

    await main();
  } finally {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    if (stdinDescriptor) {
      Object.defineProperty(process, "stdin", stdinDescriptor);
    }
    if (originalFetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = originalFetch;
    }
    for (const [key, value] of Object.entries(originalEnvValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (configPath) {
      await fs.rm(configPath, { force: true });
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }

  return {
    stdout,
    stderr,
    requests,
    output: stdout ? JSON.parse(stdout) : undefined,
  };
}

describe("Hermes Denied hook e2e", () => {
  it("allows a pre_tool_call when the PDP decision is true", async () => {
    const result = await runHook(
      {
        hook_event_name: "pre_tool_call",
        tool_name: "terminal",
        tool_input: { command: "ls -la", github_token: "secret-token" },
        session_id: "sess-1",
        cwd: "/workspace/project",
        extra: { task_id: "task-1", tool_call_id: "tool-1" },
      },
      {
        DENIED_API_KEY: "test-api-key",
        DENIED_URL: "https://pdp.test",
        DENIED_FAIL_MODE: "closed",
      },
      {
        body: {
          decision: true,
          context: { reason: "Read-only shell commands are allowed." },
        },
      },
    );
    const request = result.requests[0];

    expect(result.stderr).toBe("");
    expect(result.output).toEqual({
      reason: "Read-only shell commands are allowed.",
      message: "Read-only shell commands are allowed.",
    });
    expect(request.url).toBe("https://pdp.test/pdp/check");
    expect(request.method).toBe("POST");
    expect(request.headers["X-API-Key"]).toBe("test-api-key");
    expect(request.body).toMatchObject({
      subject: {
        type: "hermes-agent",
        id: "sess-1",
        properties: {
          runtime: "hermes-agent",
          session_id: "sess-1",
          task_id: "task-1",
          cwd: "/workspace/project",
        },
      },
      action: {
        name: "run_command",
        properties: {
          effect: "read",
          tool_name: "terminal",
          capability: "shell.command",
        },
      },
      resource: {
        type: "command",
        id: "ls",
        properties: {
          command: "ls -la",
          tool_name: "terminal",
          tool_call_id: "tool-1",
          raw_tool: {
            name: "terminal",
            input: {
              command: "ls -la",
              github_token: "[REDACTED]",
            },
          },
        },
      },
      context: {
        integration: "denied-hermes-shell-hook",
        hook_event_name: "pre_tool_call",
        authz_direction: "agent-to-world",
      },
    });
    expect(request.body).toHaveProperty(
      "context.hook_payload.tool_input.github_token",
      "[REDACTED]",
    );
  });

  it("blocks a pre_tool_call when the PDP decision is false", async () => {
    const result = await runHook(
      {
        hook_event_name: "pre_tool_call",
        tool_name: "terminal",
        tool_input: { command: "rm -rf tmp" },
        session_id: "sess-2",
        cwd: "/workspace/project",
      },
      {
        DENIED_API_KEY: "test-api-key",
        DENIED_URL: "https://pdp.test",
      },
      {
        body: {
          decision: false,
          context: { reason: "Shell deletes are not allowed." },
        },
      },
    );
    const request = result.requests[0];

    expect(result.stderr).toContain("Blocked tool call: terminal");
    expect(result.output).toEqual({
      action: "block",
      message: "Shell deletes are not allowed.",
    });
    expect(request.body).toMatchObject({
      action: {
        name: "run_command",
        properties: {
          effect: "delete",
          capability: "shell.command",
        },
      },
      resource: {
        type: "command",
        id: "rm",
        properties: {
          command: "rm -rf tmp",
        },
      },
    });
  });

  it.each([
    ["rm -rf tmp 2>/dev/null", "delete"],
    ["rm -rf tmp > /dev/null", "delete"],
    ["rm -rf tmp 2>&1", "delete"],
    ["sed -i s/a/b/ file >/dev/null", "update"],
    ["chmod 600 file >/dev/null", "update"],
    ["echo hello > file.txt", "create"],
  ])("infers shell effect for redirected command %s", async (command, effect) => {
    const result = await runHook(
      {
        hook_event_name: "pre_tool_call",
        tool_name: "terminal",
        tool_input: { command },
        session_id: "sess-redirect",
        cwd: "/workspace/project",
      },
      {
        DENIED_API_KEY: "test-api-key",
        DENIED_URL: "https://pdp.test",
      },
      {
        body: {
          decision: true,
          context: { reason: "Allowed." },
        },
      },
    );

    expect(result.requests[0].body.action.properties.effect).toBe(effect);
  });

  it("blocks fail-closed when the PDP is unavailable", async () => {
    const result = await runHook(
      {
        hook_event_name: "pre_tool_call",
        tool_name: "terminal",
        tool_input: { command: "date" },
        session_id: "sess-3",
      },
      {
        DENIED_API_KEY: "test-api-key",
        DENIED_URL: "https://pdp.test",
        DENIED_FAIL_MODE: "closed",
        DENIED_TIMEOUT_MS: "250",
      },
      new Error("fetch failed"),
    );

    expect(result.stderr).toContain("Failed to reach Denied PDP");
    expect(result.output).toMatchObject({
      action: "block",
    });
    expect(result.output).toHaveProperty(
      "message",
      expect.stringContaining("fail-mode is closed"),
    );
  });

  it("blocks fail-closed when config JSON is malformed and env fail mode is closed", async () => {
    const configPath = path.join(
      os.tmpdir(),
      `denied-hermes-invalid-${process.pid}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}.json`,
    );
    await fs.writeFile(configPath, "{ invalid json", "utf-8");

    try {
      const result = await runHook(
        {
          hook_event_name: "pre_tool_call",
          tool_name: "terminal",
          tool_input: { command: "date" },
          session_id: "sess-invalid-config",
        },
        {
          DENIED_CONFIG: configPath,
          DENIED_HERMES_CONFIG: configPath,
          DENIED_FAIL_MODE: "closed",
        },
        { body: { decision: true } },
      );

      expect(result.stderr).toContain("Failed to read Denied config");
      expect(result.output).toMatchObject({
        action: "block",
      });
      expect(result.output).toHaveProperty(
        "message",
        expect.stringContaining("fail-mode is closed"),
      );
      expect(result.requests).toEqual([]);
    } finally {
      await fs.rm(configPath, { force: true });
    }
  });

  it("allows fail-open when explicitly configured JSON is malformed", async () => {
    const configPath = path.join(
      os.tmpdir(),
      `denied-hermes-invalid-${process.pid}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}.json`,
    );
    await fs.writeFile(configPath, "{ invalid json", "utf-8");

    try {
      const result = await runHook(
        {
          hook_event_name: "pre_tool_call",
          tool_name: "terminal",
          tool_input: { command: "date" },
          session_id: "sess-invalid-config-env",
        },
        {
          DENIED_CONFIG: configPath,
          DENIED_HERMES_CONFIG: configPath,
          DENIED_API_KEY: "env-api-key",
          DENIED_URL: "https://env-pdp.test",
          DENIED_FAIL_MODE: "open",
        },
        { body: { decision: true } },
      );

      expect(result.stderr).toContain("Failed to read Denied config");
      expect(result.output).toMatchObject({
        reason: expect.stringContaining("fail-mode is open"),
      });
      expect(result.requests).toEqual([]);
    } finally {
      await fs.rm(configPath, { force: true });
    }
  });

  it("uses env config when no config file is set", async () => {
    const result = await runHook(
      {
        hook_event_name: "pre_tool_call",
        tool_name: "terminal",
        tool_input: { command: "date" },
        session_id: "sess-env-only",
      },
      {
        DENIED_API_KEY: "env-api-key",
        DENIED_URL: "https://env-pdp.test",
        DENIED_FAIL_MODE: "closed",
      },
      {
        body: {
          decision: true,
          context: { reason: "Allowed with env config." },
        },
      },
    );

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].url).toBe("https://env-pdp.test/pdp/check");
    expect(result.requests[0].headers["X-API-Key"]).toBe("env-api-key");
    expect(result.output).toEqual({
      reason: "Allowed with env config.",
      message: "Allowed with env config.",
    });
  });

  it("falls back with warnings for invalid non-secret config values", async () => {
    const result = await runHook(
      {
        hook_event_name: "pre_tool_call",
        tool_name: "terminal",
        tool_input: { command: "ls -la" },
        session_id: "sess-invalid-values",
        extra: { task_id: "task-invalid-values" },
      },
      {
        DENIED_FAIL_MODE: "strict-env",
      },
      { body: { decision: true } },
      {
        url: "https://pdp.test",
        apiKey: "test-api-key",
        failMode: "strict",
        timeoutMs: "abc",
        subjectId: "agent",
        request: {
          maxContextBytes: 0,
        },
      },
    );

    expect(result.stderr).toContain("Invalid failMode");
    expect(result.stderr).toContain("Invalid timeoutMs");
    expect(result.stderr).toContain("Invalid subjectId");
    expect(result.stderr).toContain("Invalid request.maxContextBytes");
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].body.subject.id).toBe("sess-invalid-values");
  });

  it("allows events that are not pre_tool_call without contacting the PDP", async () => {
    const result = await runHook(
      {
        hook_event_name: "post_tool_call",
        tool_name: "terminal",
        tool_input: { command: "rm -rf tmp" },
        session_id: "sess-4",
      },
      {
        DENIED_API_KEY: "test-api-key",
        DENIED_URL: "https://pdp.test",
      },
      { body: { decision: false } },
    );

    expect(result.output).toEqual({
      reason: "Denied Hermes hook only enforces pre_tool_call events.",
      message: "Denied Hermes hook only enforces pre_tool_call events.",
    });
    expect(result.requests).toEqual([]);
  });

  it("honors request config for hook payload and tool input", async () => {
    const result = await runHook(
      {
        hook_event_name: "pre_tool_call",
        tool_name: "terminal",
        tool_input: { command: "ls -la", github_token: "secret-token" },
        session_id: "sess-5",
      },
      {},
      { body: { decision: true } },
      {
        url: "https://pdp.test",
        apiKey: "test-api-key",
        request: {
          includeHookPayload: false,
          includeToolInput: false,
        },
      },
    );

    expect(result.requests[0].body.context).not.toHaveProperty("hook_payload");
    expect(result.requests[0].body.resource.properties.raw_tool).toEqual({
      name: "terminal",
    });
  });

  it("redacts inline command secrets in PDP requests and audit records", async () => {
    const auditDir = await fs.mkdtemp(path.join(os.tmpdir(), "denied-hermes-audit-"));
    try {
      const command =
        "curl -H 'Authorization: Bearer bearer-secret' --api-key cli-secret https://example.test TOKEN=env-secret";
      const result = await runHook(
        {
          hook_event_name: "pre_tool_call",
          tool_name: "terminal",
          tool_input: { command, github_token: "field-secret" },
          session_id: "sess-redact-command",
        },
        {},
        { body: { decision: true } },
        {
          url: "https://pdp.test",
          apiKey: "test-api-key",
          audit: {
            enabled: true,
            dir: auditDir,
          },
        },
      );
      const requestBody = JSON.stringify(result.requests[0].body);
      const auditRaw = await fs.readFile(
        path.join(auditDir, "denied-hermes-hook.jsonl"),
        "utf-8",
      );
      const auditRecord = JSON.parse(auditRaw.trim());
      const auditBody = JSON.stringify(auditRecord);

      expect(requestBody).not.toContain("bearer-secret");
      expect(requestBody).not.toContain("cli-secret");
      expect(requestBody).not.toContain("env-secret");
      expect(requestBody).not.toContain("field-secret");
      expect(result.requests[0].body.resource.properties.command).toContain(
        "Authorization: Bearer [REDACTED]",
      );
      expect(result.requests[0].body.resource.properties.command).toContain(
        "--api-key [REDACTED]",
      );
      expect(result.requests[0].body.context.hook_payload.tool_input.command).toContain(
        "TOKEN=[REDACTED]",
      );
      expect(auditBody).not.toContain("bearer-secret");
      expect(auditBody).not.toContain("cli-secret");
      expect(auditBody).not.toContain("env-secret");
      expect(auditBody).not.toContain("field-secret");
    } finally {
      await fs.rm(auditDir, { recursive: true, force: true });
    }
  });

  it("honors redaction.enabled false", async () => {
    const result = await runHook(
      {
        hook_event_name: "pre_tool_call",
        tool_name: "terminal",
        tool_input: {
          command: "curl --token secret-token https://example.test",
          github_token: "secret-token",
        },
        session_id: "sess-6",
      },
      {},
      { body: { decision: true } },
      {
        url: "https://pdp.test",
        apiKey: "test-api-key",
        redaction: {
          enabled: false,
        },
      },
    );

    expect(result.requests[0].body).toHaveProperty(
      "resource.properties.raw_tool.input.github_token",
      "secret-token",
    );
    expect(result.requests[0].body).toHaveProperty(
      "resource.properties.command",
      "curl --token secret-token https://example.test",
    );
    expect(result.requests[0].body).toHaveProperty(
      "context.hook_payload.tool_input.github_token",
      "secret-token",
    );
    expect(result.requests[0].body).toHaveProperty(
      "context.hook_payload.tool_input.command",
      "curl --token secret-token https://example.test",
    );
  });

  it("truncates oversized command and raw tool input in PDP requests", async () => {
    const longCommand = `echo ${"x".repeat(500)}`;
    const result = await runHook(
      {
        hook_event_name: "pre_tool_call",
        tool_name: "terminal",
        tool_input: {
          command: longCommand,
          payload: "y".repeat(500),
        },
        session_id: "sess-large-input",
      },
      {},
      { body: { decision: true } },
      {
        url: "https://pdp.test",
        apiKey: "test-api-key",
        request: {
          maxContextBytes: 120,
        },
      },
    );

    expect(result.requests[0].body.resource.properties.command).toMatchObject({
      truncated: true,
      max_bytes: 120,
    });
    expect(result.requests[0].body.resource.properties.raw_tool.input).toMatchObject({
      truncated: true,
      max_bytes: 120,
    });
    expect(result.requests[0].body.context.hook_payload).toMatchObject({
      truncated: true,
      max_bytes: 120,
    });
  });

  it("uses generic tool resources when semantic mapping is disabled", async () => {
    const result = await runHook(
      {
        hook_event_name: "pre_tool_call",
        tool_name: "terminal",
        tool_input: { command: "ls -la" },
        session_id: "sess-7",
      },
      {},
      { body: { decision: true } },
      {
        url: "https://pdp.test",
        apiKey: "test-api-key",
        useSemanticMapping: false,
      },
    );

    expect(result.requests[0].body).toMatchObject({
      action: {
        name: "run_command",
        properties: {
          effect: "read",
          capability: "tool.call",
        },
      },
      resource: {
        type: "tool",
        id: "terminal",
      },
    });
    expect(result.requests[0].body.resource.properties).not.toHaveProperty("command");
  });

  it.each([
    ["task", "task-8"],
    ["tool_call", "tool-8"],
  ])("uses %s as the subject id when configured", async (subjectId, expectedId) => {
    const result = await runHook(
      {
        hook_event_name: "pre_tool_call",
        tool_name: "terminal",
        tool_input: { command: "ls -la" },
        session_id: "sess-8",
        extra: { task_id: "task-8", tool_call_id: "tool-8" },
      },
      {},
      { body: { decision: true } },
      {
        url: "https://pdp.test",
        apiKey: "test-api-key",
        subjectId,
      },
    );

    expect(result.requests[0].body.subject.id).toBe(expectedId);
  });
});
