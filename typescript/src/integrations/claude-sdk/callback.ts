/**
 * Permission callback factory for Claude Agent SDK integration with Denied.
 */

import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { DeniedClient } from "../../client";
import type { CheckRequest, CheckResponse } from "../../schemas";
import type { AuthorizationConfig, ResolvedAuthorizationConfig } from "./config";
import { resolveConfig } from "./config";
import { ContextMapper } from "./context-mapper";

/**
 * Options for creating a Denied permission callback.
 */
export interface CreatePermissionCallbackOptions {
  /**
   * Authorization configuration. If not provided, uses default config
   * with environment variables.
   */
  config?: AuthorizationConfig;

  /**
   * Optional pre-configured DeniedClient. If not provided,
   * creates a new client from config.
   */
  deniedClient?: DeniedClient;

  /**
   * User ID for subject identification. Overrides config.userId.
   */
  userId?: string;

  /**
   * Session ID for subject properties. Overrides config.sessionId.
   */
  sessionId?: string;

  /**
   * Custom properties to include in the subject (e.g., \{ role: "admin" \}).
   * These are merged with userId/sessionId.
   */
  subjectProperties?: Record<string, unknown>;

  /**
   * Custom properties to include in the resource (e.g., \{ scope: "user" \}).
   * These are merged with toolName/toolInput.
   */
  resourceProperties?: Record<string, unknown>;
}

/**
 * Perform authorization check with retry logic.
 *
 * @param client - The Denied client.
 * @param checkRequest - The authorization check request.
 * @param config - Authorization configuration.
 * @returns CheckResponse if successful, null if all retries failed.
 */
async function checkWithRetry(
  client: DeniedClient,
  checkRequest: CheckRequest,
  config: ResolvedAuthorizationConfig,
): Promise<CheckResponse | null> {
  for (let attempt = 0; attempt <= config.retryAttempts; attempt++) {
    try {
      return await client.check({
        subject: checkRequest.subject,
        action: checkRequest.action,
        resource: checkRequest.resource,
        context: checkRequest.context,
      });
    } catch (error) {
      const isFinalAttempt = attempt === config.retryAttempts;

      if (isFinalAttempt) {
        console.error(
          `Authorization check failed after ${attempt + 1} attempts:`,
          error,
        );
        return null;
      }

      // Exponential backoff: 0.1s, 0.2s, 0.4s, ...
      const backoffMs = Math.pow(2, attempt) * 100;
      console.warn(
        `Authorization check failed (attempt ${
          attempt + 1
        }), retrying in ${backoffMs}ms:`,
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  return null;
}

/**
 * Factory function to create a Denied authorization permission callback.
 *
 * Creates a callback function compatible with Claude Agent SDK's can_use_tool
 * option. The callback performs authorization checks against the Denied service
 * before allowing tool execution.
 *
 * @param options - Options for creating the callback.
 * @returns An async callback function compatible with ClaudeAgentOptions.canUseTool.
 *
 * @example
 * ```typescript
 * import { query } from "@anthropic-ai/claude-agent-sdk";
 * import { createDeniedPermissionCallback } from "denied-sdk";
 *
 * // Create the callback with user context, role, and resource scope
 * const permissionCallback = createDeniedPermissionCallback({
 *   userId: "user-123",
 *   subjectProperties: { role: "user" },
 *   resourceProperties: { scope: "user" },
 * });
 *
 * // Use with Claude Agent SDK
 * const response = query({
 *   prompt: "List files in the current directory",
 *   options: {
 *     canUseTool: permissionCallback,
 *   },
 * });
 *
 * for await (const message of response) {
 *   console.log(message);
 * }
 * ```
 */
export function createDeniedPermissionCallback(
  options: CreatePermissionCallbackOptions = {},
): CanUseTool {
  // Build effective config with overrides
  const configOverrides: AuthorizationConfig = {
    ...options.config,
  };

  // Apply userId/sessionId overrides
  if (options.userId !== undefined) {
    configOverrides.userId = options.userId;
  }
  if (options.sessionId !== undefined) {
    configOverrides.sessionId = options.sessionId;
  }

  const effectiveConfig = resolveConfig(configOverrides);

  // Store properties for the mapper
  const effectiveSubjectProperties = options.subjectProperties ?? {};
  const effectiveResourceProperties = options.resourceProperties ?? {};

  // Create client if not provided
  const client =
    options.deniedClient ??
    new DeniedClient({
      url: effectiveConfig.deniedUrl,
      apiKey: effectiveConfig.deniedApiKey,
    });

  const mapper = new ContextMapper(
    effectiveConfig,
    effectiveSubjectProperties,
    effectiveResourceProperties,
  );

  /**
   * Permission callback that checks authorization via Denied service.
   */
  const deniedPermissionCallback: CanUseTool = async (
    toolName: string,
    inputData: Record<string, unknown>,
    _options: {
      signal: AbortSignal;
      toolUseID: string;
      agentID?: string;
    },
  ): Promise<PermissionResult> => {
    // Build authorization request
    const checkRequest = mapper.createCheckRequest(toolName, inputData);

    // Perform authorization check with retry
    const checkResult = await checkWithRetry(client, checkRequest, effectiveConfig);

    // Handle service unavailability
    if (checkResult === null) {
      console.warn(
        `Authorization service unavailable for tool=${toolName}, ` +
          `failMode=${effectiveConfig.failMode}`,
      );

      if (effectiveConfig.failMode === "closed") {
        return {
          behavior: "deny",
          message: "Authorization service unavailable (fail-closed mode)",
        };
      }

      // Fail open - allow execution
      console.warn(`Allowing tool=${toolName} execution in fail-open mode`);
      return {
        behavior: "allow",
        updatedInput: inputData,
      };
    }

    // Handle authorization decision
    if (!checkResult.decision) {
      return {
        behavior: "deny",
        message: checkResult.context?.reason || "Authorization denied",
      };
    }

    return {
      behavior: "allow",
      updatedInput: inputData,
    };
  };

  return deniedPermissionCallback;
}
