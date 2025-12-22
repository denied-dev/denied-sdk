/**
 * Shared action pattern extraction for tool authorization.
 *
 * This module provides common action pattern matching used across
 * different SDK integrations (Claude Agent SDK, Google ADK, etc.).
 */

type ActionPattern = [RegExp, string];

// Bash command patterns for action inference
// Order matters: more specific patterns first
const BASH_ACTION_PATTERNS: ActionPattern[] = [
  // Write/create operations - file redirection
  [/[^|]>\s*\S|[^|]>>\s*\S/, "create"], // > or >> (not |>)
  // Write/create operations - common write commands
  // Note: 'install' excluded as it often appears in package manager commands (npm install, pip install)
  [/\b(cp|mv|mkdir|touch|rsync|scp|wget\s+-O|curl\s+-o)\b/i, "create"],
  // Write/create operations - text manipulation to files
  [/\b(tee|dd)\b/i, "create"],
  // Delete operations
  [/\b(rm|rmdir|unlink)\b/i, "delete"],
  // Update operations - in-place file modifications
  [/\bsed\s+-i\b/i, "update"],
  [/\bchmod\b|\bchown\b|\bchgrp\b/i, "update"],
  // Read operations - common read-only commands
  [
    /\b(cat|head|tail|less|more|grep|find|ls|pwd|whoami|echo(?!\s.*>)|file|stat|wc|diff|which|type|env|printenv|date|uname)\b/i,
    "read",
  ],
];

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
  // Execute operations - Note: Bash is handled specially via extractBashAction
  [/^(Task|TodoWrite|KillShell)$/i, "execute"],

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
 * Extract action from a Bash command string.
 *
 * Analyzes the command content to determine the actual operation type,
 * since Bash can perform read, write, delete, or execute operations.
 *
 * @param command - The bash command string to analyze.
 * @returns Action string based on command analysis.
 */
function extractBashAction(command: string): string {
  for (const [pattern, action] of BASH_ACTION_PATTERNS) {
    if (pattern.test(command)) {
      return action;
    }
  }

  // Default for unknown bash commands
  return "execute";
}

/**
 * Extract action from tool name and optionally tool input.
 *
 * Attempts to infer the action from the tool name by matching
 * common verb patterns (read, create, update, delete, execute).
 * Falls back to "execute" if no pattern matches.
 *
 * For the Bash tool, analyzes the command content to determine
 * the actual operation type (read, create, update, delete, execute).
 *
 * Supports both:
 * - Claude Code built-in tools (Read, Write, Edit, Bash, etc.)
 * - MCP tool naming conventions (read_file, create_user, etc.)
 *
 * @param toolName - Name of the tool being invoked.
 * @param toolInput - Optional tool input arguments. Used for Bash command analysis.
 * @returns Action string: "read", "create", "update", "delete", or "execute".
 *
 * @example
 * extractAction("Read")                                    // => "read"
 * extractAction("Write")                                   // => "create"
 * extractAction("Bash", { command: "ls -la" })             // => "read"
 * extractAction("Bash", { command: "echo hello > file.txt" }) // => "create"
 * extractAction("Bash", { command: "rm file.txt" })        // => "delete"
 * extractAction("get_user")                                // => "read"
 * extractAction("delete_file")                             // => "delete"
 * extractAction("unknown_tool")                            // => "execute"
 */
export function extractAction(
  toolName: string,
  toolInput?: Record<string, unknown>,
): string {
  // Special handling for Bash tool - analyze command content
  if (toolName.toLowerCase() === "bash" && toolInput) {
    const command = toolInput.command;
    if (typeof command === "string" && command) {
      return extractBashAction(command);
    }
  }

  for (const [pattern, action] of ACTION_PATTERNS) {
    if (pattern.test(toolName)) {
      return action;
    }
  }

  // Default action
  return "execute";
}
