/**
 * Base exception for all authorization-related errors.
 */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * Raised when an authorization check explicitly denies access.
 */
export class AuthorizationDeniedError extends AuthorizationError {
  public readonly reason?: string;

  constructor(reason?: string) {
    const message = reason ? `Authorization denied: ${reason}` : "Authorization denied";
    super(message);
    this.name = "AuthorizationDeniedError";
    this.reason = reason;
  }
}

/**
 * Raised when the authorization service is unavailable.
 */
export class AuthorizationServiceError extends AuthorizationError {
  public readonly originalError?: Error;

  constructor(message: string, originalError?: Error) {
    super(message);
    this.name = "AuthorizationServiceError";
    this.originalError = originalError;
  }
}

/**
 * Raised for configuration errors.
 */
export class ConfigurationError extends AuthorizationError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}
