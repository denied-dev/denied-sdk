/**
 * Base interface for subjects and resources following Authzen specification
 */
export interface SubjectOrResource {
  type: string;
  id: string;
  properties?: Record<string, unknown>;
}

/**
 * Subject (user, service, etc.) in an authorization check
 */
export interface Subject extends SubjectOrResource {}

/**
 * Resource (document, API, etc.) in an authorization check
 */
export interface Resource extends SubjectOrResource {}

/**
 * Action being performed in an authorization check
 */
export interface Action {
  name: string;
  properties?: Record<string, unknown>;
}

/**
 * Request to check authorization following Authzen specification
 */
export interface CheckRequest {
  subject: Subject;
  resource: Resource;
  action: Action;
  context?: Record<string, unknown>;
}

/**
 * Context information in an authorization response
 */
export interface CheckResponseContext {
  reason?: string;
  rules?: string[];
}

/**
 * Response from an authorization check following Authzen specification
 */
export interface CheckResponse {
  decision: boolean;
  context?: CheckResponseContext;
}
