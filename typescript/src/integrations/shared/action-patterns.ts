/**
 * Shared action pattern extraction for tool authorization.
 *
 * This module provides common action pattern matching used across
 * different SDK integrations (Claude Agent SDK, Google ADK, etc.).
 */

type ActionPattern = [RegExp, string];

// Action verb mapping for tool name patterns
// Combines Claude Code built-in tools with MCP tool naming conventions
const ACTION_PATTERNS: ActionPattern[] = [
  // === Claude Code Built-in Tools (exact matches) ===
  // Read operations
  [
    /^(Read|Glob|Grep|WebFetch|WebSearch|ListMcpResourcesTool|ReadMcpResourceTool)$/i,
    "read",
  ],
  // Create/Write operations
  [/^(Write|NotebookEdit)$/i, "create"],
  // Update operations
  [/^(Edit|MultiEdit)$/i, "update"],
  // Execute operations
  [/^(Bash|Task|TodoWrite|KillShell)$/i, "execute"],

  // === MCP Tool Naming Patterns ===
  // NOTE: More specific patterns must come BEFORE general patterns

  // Execute operations (before "query" matches as read)
  [/(^|_)(execute|run|call|invoke|batch)(_|$)/i, "execute"],
  // Special operations - map to most appropriate action (before "add" matches as create)
  [/(^|_)(share|add_.*_member)(_|$)/i, "update"],
  // Resource manipulation
  [/(^|_)(merge|fork|copy|move)(_|$)/i, "update"],
  // State changes
  [/(^|_)(lock|unlock|restore)(_|$)/i, "update"],
  // Delete operations
  [/(^|_)(delete|remove|drop|unshare)(_|$)/i, "delete"],
  // Update operations
  [/(^|_)(update|modify|edit|change|set|patch|rename|mark)(_|$)/i, "update"],
  // Create/Write operations
  [/(^|_)(write|create|add|insert|post|save|send|upload)(_|$)/i, "create"],
  // Read operations (most general, last)
  [/(^|_)(read|get|fetch|load|list|search|query|retrieve)(_|$)/i, "read"],
];

/**
 * Extract action from tool name.
 *
 * Attempts to infer the action from the tool name by matching
 * common verb patterns (read, create, update, delete, execute).
 * Falls back to "execute" if no pattern matches.
 *
 * Supports both:
 * - Claude Code built-in tools (Read, Write, Edit, Bash, etc.)
 * - MCP tool naming conventions (read_file, create_user, etc.)
 *
 * @param toolName - Name of the tool being invoked.
 * @returns Action string: "read", "create", "update", "delete", or "execute".
 *
 * @example
 * extractAction("Read")         // => "read"
 * extractAction("Write")        // => "create"
 * extractAction("get_user")     // => "read"
 * extractAction("delete_file")  // => "delete"
 * extractAction("unknown_tool") // => "execute"
 */
export function extractAction(toolName: string): string {
  for (const [pattern, action] of ACTION_PATTERNS) {
    if (pattern.test(toolName)) {
      return action;
    }
  }

  // Default action
  return "execute";
}
