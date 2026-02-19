/**
 * Maps Claude Agent SDK tool execution context to Denied authorization model.
 */

import type { Action, CheckRequest, Resource, Subject } from "../../schemas";
import { extractAction } from "../shared";
import type { ResolvedAuthorizationConfig } from "./config";

/**
 * Maps Claude Agent SDK tool execution context to Denied authorization model.
 *
 * This class extracts relevant context from Claude SDK's tool permission callback
 * parameters to construct authorization requests for the Denied service.
 */
export class ContextMapper {
  private readonly config: ResolvedAuthorizationConfig;
  private readonly subjectProperties: Record<string, unknown>;
  private readonly resourceProperties: Record<string, unknown>;

  /**
   * Initialize the context mapper.
   *
   * @param config - Configuration controlling context extraction.
   * @param subjectProperties - Custom properties to include in the subject (e.g., \{ role: "admin" \}).
   * @param resourceProperties - Custom properties to include in the resource (e.g., \{ scope: "user" \}).
   */
  constructor(
    config: ResolvedAuthorizationConfig,
    subjectProperties?: Record<string, unknown>,
    resourceProperties?: Record<string, unknown>,
  ) {
    this.config = config;
    this.subjectProperties = subjectProperties ?? {};
    this.resourceProperties = resourceProperties ?? {};
  }

  /**
   * Extract subject information from configuration.
   *
   * Since Claude Agent SDK's can_use_tool callback doesn't provide user context
   * directly, subject information is captured at callback creation time via
   * the factory pattern.
   *
   * @returns Subject with type, id, and properties for the subject.
   */
  extractSubject(): Subject {
    // Start with custom subject properties (e.g., role, scope)
    const properties: Record<string, unknown> = { ...this.subjectProperties };

    // Add user_id and session_id if provided
    if (this.config.userId) {
      properties.user_id = this.config.userId;
    }

    if (this.config.sessionId) {
      properties.session_id = this.config.sessionId;
    }

    // Build subject id
    const subjectId = this.config.userId ?? "claude-agent";

    return {
      type: "user",
      id: subjectId,
      properties: Object.keys(properties).length > 0 ? properties : undefined,
    };
  }

  /**
   * Extract resource information from tool and arguments.
   *
   * @param toolName - Name of the tool being invoked.
   * @param toolInput - Arguments passed to the tool.
   * @returns Resource with type, id, and properties for the resource.
   */
  extractResource(toolName: string, toolInput: Record<string, unknown>): Resource {
    // Start with custom resource properties (e.g., scope)
    const properties: Record<string, unknown> = { ...this.resourceProperties };

    // Add tool name
    properties.tool_name = toolName;

    // Add tool input if configured (aligned with ADK structure)
    if (this.config.extractToolArgs && Object.keys(toolInput).length > 0) {
      properties.tool_input = { values: toolInput };
    }

    return {
      type: "tool",
      id: toolName,
      properties,
    };
  }

  /**
   * Create a complete authorization check request.
   *
   * @param toolName - Name of the tool being invoked.
   * @param toolInput - Arguments passed to the tool.
   * @returns CheckRequest ready to send to Denied service.
   */
  createCheckRequest(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): CheckRequest {
    const subject = this.extractSubject();
    const resource = this.extractResource(toolName, toolInput);
    // Pass toolInput for Bash command analysis
    const actionName = extractAction(toolName, toolInput);
    const action: Action = { name: actionName };

    return {
      subject,
      resource,
      action,
    };
  }
}
