/**
 * Denied authorization callback with Claude Agent SDK.
 *
 * This example intercepts Claude Code's BUILT-IN tools (Read, Write, Bash, Edit, etc.)
 * before they execute. The Denied callback checks authorization for each tool call.
 *
 * Two scenarios demonstrate read vs write permissions:
 * - Write file: blocked (create action denied)
 * - Read file: allowed (read action permitted)
 *
 * How it works:
 * 1. User sends message: "Create a file called hello.txt"
 * 2. Claude decides to use its built-in Write tool
 * 3. SDK calls our permission callback with: toolName="Write", input={file_path: ...}
 * 4. Callback extracts action="create" and sends check to Denied
 * 5. Denied evaluates policy → DENY (create not allowed)
 * 6. Callback returns { behavior: "deny", message: "..." }
 * 7. Claude receives denial, cannot complete the action
 *
 * Bash command analysis:
 * - The callback analyzes Bash commands to determine actual intent
 * - "echo hello > file.txt" → action="create" (file redirect)
 * - "rm file.txt" → action="delete"
 * - "cat file.txt" → action="read"
 * - This prevents bypassing Write restrictions via Bash
 *
 * Policy Rules (in Denied):
 * - Allow: input.action == "read"
 * - Deny: everything else (create, update, delete, execute)
 *
 * Setup:
 * 1. Install: pnpm add @anthropic-ai/claude-agent-sdk denied-sdk
 * 2. Set env vars:
 *    export ANTHROPIC_API_KEY='your-key'
 *    export DENIED_API_KEY='your-key'
 * 3. Run: npx ts-node examples/claude-agent-sdk/internal-tools.ts
 */

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import "dotenv/config";
import { createDeniedPermissionCallback } from "../../src/integrations/claude-sdk";

interface ScenarioOptions {
  name: string;
  userId: string;
  message: string;
}

async function runScenario(options: ScenarioOptions): Promise<void> {
  const { name, userId, message } = options;

  console.log("\n" + "=".repeat(60));
  console.log(`Scenario: ${name}`);
  console.log(`User: ${userId}`);
  console.log(`Message: ${message}`);
  console.log("-".repeat(60));

  // Create permission callback - intercepts ALL built-in tool calls
  const permissionCallback = createDeniedPermissionCallback({
    config: {
      deniedUrl: process.env.DENIED_URL,
      deniedApiKey: process.env.DENIED_API_KEY,
      failMode: "closed",
      timeoutSeconds: 15,
    },
    userId,
  });

  try {
    const response = query({
      prompt: message,
      options: {
        model: "claude-3-5-haiku-20241022",
        canUseTool: permissionCallback,
        cwd: "/tmp",
      },
    });

    for await (const msg of response) {
      handleMessage(msg);
    }
  } catch (error) {
    console.error("\nError:", error);
  }
}

function handleMessage(msg: SDKMessage): void {
  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`\nClaude: ${block.text.slice(0, 500)}`);
      }
    }
  } else if (msg.type === "result") {
    if (msg.subtype === "success") {
      console.log(`\nDone (${msg.duration_ms}ms)`);
    } else {
      console.log(`\nCompleted with errors: ${msg.errors?.join(", ")}`);
    }
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Claude Agent SDK + Denied Authorization");
  console.log("=".repeat(60));
  console.log("\nThis demo intercepts Claude Code's BUILT-IN tools:");
  console.log("Read, Write, Edit, Bash, Glob, Grep, WebFetch, Task, etc.");
  console.log("\nEach tool call goes through our permission callback -> Denied");

  // First create a file so we have something to read
  console.log("\n[Setup: Creating test file...]");
  require("fs").writeFileSync("/tmp/hello.txt", "Hello World\n");

  await runScenario({
    name: "Write file (DENY - create action blocked)",
    userId: "alice",
    message: "Create a file /tmp/test.txt with contents 'Test content'",
  });

  await runScenario({
    name: "Read file (ALLOW - read action permitted)",
    userId: "alice",
    message: "Read the contents of /tmp/hello.txt",
  });

  console.log("\n" + "=".repeat(60));
  console.log("Demo completed!");
  console.log("=".repeat(60) + "\n");
}

// Check required environment variables
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

if (!process.env.DENIED_URL && !process.env.DENIED_API_KEY) {
  console.error("DENIED_URL or DENIED_API_KEY not set");
  process.exit(1);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
