import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { main } = require("./denied-hermes-hook.js");
const unusedConfigPath = path.join(
  os.tmpdir(),
  `denied-hermes-missing-${process.pid}.json`,
);

async function runHook(payload, env, fetchResult, config) {
  let stdout = "";
  let stderr = "";
  const requests = [];
  let configPath;
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
    DENIED_CONFIG: configPath || unusedConfigPath,
    DENIED_HERMES_CONFIG: configPath || unusedConfigPath,
    ...env,
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
      "context.raw_payload.tool_input.github_token",
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

    expect(result.requests[0].body.context).not.toHaveProperty("raw_payload");
    expect(result.requests[0].body.resource.properties.raw_tool).toEqual({
      name: "terminal",
    });
  });

  it("honors redaction.enabled false", async () => {
    const result = await runHook(
      {
        hook_event_name: "pre_tool_call",
        tool_name: "terminal",
        tool_input: { command: "ls -la", github_token: "secret-token" },
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
      "context.raw_payload.tool_input.github_token",
      "secret-token",
    );
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
