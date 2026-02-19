/**
 * Denied authorization callback with custom MCP server tools.
 *
 * This example shows authorization on CUSTOM MCP TOOLS (not just built-in tools).
 * We define a simple "project" MCP server with read_project, delete_project, and
 * create_project tools. The Denied callback intercepts these custom tool calls.
 *
 * Two scenarios test the same user reading projects with different resource scopes:
 * - User scope: can read (allowed)
 * - Admin scope: blocked from reading (denied)
 *
 * How it works:
 * 1. User sends message: "Get details for project prj-123"
 * 2. Claude sees our custom MCP tool `mcp__projects__read_project`
 * 3. SDK calls our permission callback with: tool_name="mcp__projects__read_project"
 * 4. Callback maps tool name -> action="read", sends check to Denied
 * 5. Denied evaluates policy -> ALLOW or DENY based on scope
 * 6. Callback returns { behavior: "allow" } or { behavior: "deny" }
 * 7. Claude proceeds or receives denial
 *
 * Policy Rules (in Denied):
 * - Allow: principal.role='user' AND resource.scope='user' AND action='read'
 *
 * Setup:
 * 1. Install: pnpm add @anthropic-ai/claude-agent-sdk
 * 2. Set env vars:
 *    export ANTHROPIC_API_KEY='your-key'
 *    export DENIED_API_KEY='your-key'
 * 3. Run: npx ts-node examples/claude-agent-sdk/mcp-server-auth.ts
 */

import {
  createSdkMcpServer,
  query,
  tool,
  type McpSdkServerConfigWithInstance,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import "dotenv/config";
import { z } from "zod";
import { createDeniedPermissionCallback } from "../../src/integrations/claude-sdk";

// =============================================================================
// Custom MCP Tools - These are the tools we're protecting with Denied
// =============================================================================

const readProjectTool = tool(
  "read_project",
  "Read project details by ID",
  { project_id: z.string().describe("The project ID to read") },
  async (args) => {
    // Mock project data
    return {
      content: [
        {
          type: "text" as const,
          text: `Project ${args.project_id}: name='My Project', status='active', owner='alice'`,
        },
      ],
    };
  },
);

const deleteProjectTool = tool(
  "delete_project",
  "Delete a project by ID",
  { project_id: z.string().describe("The project ID to delete") },
  async (args) => {
    return {
      content: [
        {
          type: "text" as const,
          text: `Project ${args.project_id} has been deleted.`,
        },
      ],
    };
  },
);

const createProjectTool = tool(
  "create_project",
  "Create a new project",
  {
    name: z.string().describe("Project name"),
    description: z.string().describe("Project description"),
  },
  async (args) => {
    return {
      content: [
        {
          type: "text" as const,
          text: `Created project '${args.name}' with ID prj-new-123`,
        },
      ],
    };
  },
);

// =============================================================================
// Demo scenarios
// =============================================================================

interface ScenarioOptions {
  name: string;
  userId: string;
  role: string;
  scope: string;
  message: string;
  projectsServer: McpSdkServerConfigWithInstance;
}

async function runScenario(options: ScenarioOptions): Promise<void> {
  const { name, userId, role, scope, message, projectsServer } = options;

  console.log("\n" + "=".repeat(60));
  console.log(`Scenario: ${name}`);
  console.log(`User: ${userId} (role=${role}, scope=${scope})`);
  console.log(`Message: ${message}`);
  console.log("-".repeat(60));

  // Permission callback intercepts ALL tool calls including our custom MCP tools
  // Tool names will be like: mcp__projects__read_project, mcp__projects__delete_project
  // Pass principal_attributes with role and resource_attributes with scope for policy matching
  const permissionCallback = createDeniedPermissionCallback({
    config: {
      deniedUrl: process.env.DENIED_URL,
      deniedApiKey: process.env.DENIED_API_KEY,
      failMode: "closed",
      timeoutSeconds: 15, // Allow for cold starts
    },
    userId,
    principalAttributes: { role },
    resourceAttributes: { scope },
  });

  // IMPORTANT: Do NOT use allowedTools here!
  // allowedTools auto-approves tools without going through the permission callback.
  // We want all tool calls to go through our Denied authorization callback.
  try {
    const response = query({
      prompt: message,
      options: {
        model: "claude-3-5-haiku-20241022", // Cheapest model
        mcpServers: { projects: projectsServer },
        canUseTool: permissionCallback,
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
  console.log("Claude Agent SDK + Denied + Custom MCP Tools");
  console.log("=".repeat(60));
  console.log("\nThis demo shows authorization on CUSTOM MCP TOOLS:");
  console.log("- read_project -> action='read'");
  console.log("\nTwo scenarios with different resource scopes:");
  console.log("- scope='user' -> ALLOW");
  console.log("- scope='admin' -> DENY");

  // Create our custom MCP server with project tools
  const projectsServer = createSdkMcpServer({
    name: "projects",
    version: "1.0.0",
    tools: [readProjectTool, deleteProjectTool, createProjectTool],
  });

  // Scenario 1: User reads user-scoped project (should ALLOW)
  await runScenario({
    name: "User reads user-scoped project (read -> ALLOW)",
    userId: "alice",
    role: "user",
    scope: "user",
    message: "Get details for project prj-123",
    projectsServer,
  });

  // Scenario 2: User reads admin-scoped project (should DENY)
  await runScenario({
    name: "User reads admin-scoped project (read -> DENY)",
    userId: "alice",
    role: "user",
    scope: "admin",
    message: "Get details for project prj-456",
    projectsServer,
  });

  console.log("\n" + "=".repeat(60));
  console.log("Demo completed!");
  console.log("=".repeat(60));
}

// Check required environment variables
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

if (!process.env.DENIED_URL && !process.env.DENIED_API_KEY) {
  console.error("Neither DENIED_URL nor DENIED_API_KEY is set");
  process.exit(1);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
