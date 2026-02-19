/**
 * Configuration for the Denied authorization callback with Claude Agent SDK.
 */
export interface AuthorizationConfig {
  /**
   * URL of the Denied authorization service.
   * Defaults to DENIED_URL environment variable or "https://api.denied.dev".
   */
  deniedUrl?: string;

  /**
   * API key for the Denied service.
   * Defaults to DENIED_API_KEY environment variable.
   */
  deniedApiKey?: string;

  /**
   * How to handle authorization service failures.
   * - "closed" (default): Deny access when service is unavailable (secure).
   * - "open": Allow access when service is unavailable (available).
   */
  failMode?: "closed" | "open";

  /**
   * Number of retry attempts for failed authorization checks.
   * @default 2
   */
  retryAttempts?: number;

  /**
   * Timeout for authorization service requests in seconds.
   * @default 5
   */
  timeoutSeconds?: number;

  /**
   * Whether to extract tool arguments into resource properties.
   * @default true
   */
  extractToolArgs?: boolean;

  /**
   * User ID to use for subject identification.
   * Can be provided at callback creation.
   */
  userId?: string;

  /**
   * Session ID to include in subject properties.
   */
  sessionId?: string;
}

/**
 * Resolved configuration with all defaults applied.
 */
export interface ResolvedAuthorizationConfig {
  deniedUrl: string;
  deniedApiKey?: string;
  failMode: "closed" | "open";
  retryAttempts: number;
  timeoutSeconds: number;
  extractToolArgs: boolean;
  userId?: string;
  sessionId?: string;
}

/**
 * Resolve configuration by applying defaults from environment variables.
 *
 * @param config - Partial configuration to resolve.
 * @returns Fully resolved configuration with defaults applied.
 */
export function resolveConfig(
  config?: AuthorizationConfig,
): ResolvedAuthorizationConfig {
  const deniedUrl =
    config?.deniedUrl ?? process.env.DENIED_URL ?? "https://api.denied.dev";

  const deniedApiKey = config?.deniedApiKey ?? process.env.DENIED_API_KEY;

  return {
    deniedUrl,
    deniedApiKey,
    failMode: config?.failMode ?? "closed",
    retryAttempts: config?.retryAttempts ?? 2,
    timeoutSeconds: config?.timeoutSeconds ?? 5,
    extractToolArgs: config?.extractToolArgs ?? true,
    userId: config?.userId,
    sessionId: config?.sessionId,
  };
}
