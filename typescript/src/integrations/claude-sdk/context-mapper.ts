/**
 * Maps Claude Agent SDK tool execution context to Denied authorization model.
 */

import { EntityType } from "../../enums";
import type { CheckRequest, PrincipalCheck, ResourceCheck } from "../../schemas";
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
  private readonly principalAttributes: Record<string, unknown>;
  private readonly resourceAttributes: Record<string, unknown>;

  /**
   * Initialize the context mapper.
   *
   * @param config - Configuration controlling context extraction.
   * @param principalAttributes - Custom attributes to include in the principal (e.g., \{ role: "admin" \}).
   * @param resourceAttributes - Custom attributes to include in the resource (e.g., \{ scope: "user" \}).
   */
  constructor(
    config: ResolvedAuthorizationConfig,
    principalAttributes?: Record<string, unknown>,
    resourceAttributes?: Record<string, unknown>,
  ) {
    this.config = config;
    this.principalAttributes = principalAttributes ?? {};
    this.resourceAttributes = resourceAttributes ?? {};
  }

  /**
   * Extract principal information from configuration.
   *
   * Since Claude Agent SDK's can_use_tool callback doesn't provide user context
   * directly, principal information is captured at callback creation time via
   * the factory pattern.
   *
   * @returns PrincipalCheck with URI and attributes for the principal.
   */
  extractPrincipal(): PrincipalCheck {
    // Start with custom principal attributes (e.g., role, scope)
    const attributes: Record<string, unknown> = { ...this.principalAttributes };

    // Add user_id and session_id if provided
    if (this.config.userId) {
      attributes.user_id = this.config.userId;
    }

    if (this.config.sessionId) {
      attributes.session_id = this.config.sessionId;
    }

    // Build principal URI
    const principalId = this.config.userId ?? "claude-agent";
    const principalUri = `user:${principalId}`;

    return {
      type: EntityType.Principal,
      uri: principalUri,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    };
  }

  /**
   * Extract resource information from tool and arguments.
   *
   * @param toolName - Name of the tool being invoked.
   * @param toolInput - Arguments passed to the tool.
   * @returns ResourceCheck with URI and attributes for the resource.
   */
  extractResource(toolName: string, toolInput: Record<string, unknown>): ResourceCheck {
    // Start with custom resource attributes (e.g., scope)
    const attributes: Record<string, unknown> = { ...this.resourceAttributes };

    // Add tool name
    attributes.tool_name = toolName;

    // Add tool input if configured (aligned with ADK structure)
    if (this.config.extractToolArgs && Object.keys(toolInput).length > 0) {
      attributes.tool_input = { values: toolInput };
    }

    // Build resource URI
    const resourceUri = `tool:${toolName}`;

    return {
      type: EntityType.Resource,
      uri: resourceUri,
      attributes,
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
    const principal = this.extractPrincipal();
    const resource = this.extractResource(toolName, toolInput);
    // Pass toolInput for Bash command analysis
    const action = extractAction(toolName, toolInput);

    return {
      principal,
      resource,
      action,
    };
  }
}
