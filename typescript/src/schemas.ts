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
 * Accepted input types for subject/resource: typed object or "type://id" string
 */
export type SubjectLike = Subject | string;
export type ResourceLike = Resource | string;

/**
 * Accepted input types for action: typed object or action name string
 */
export type ActionLike = Action | string;

/**
 * Request to check authorization following Authzen specification
 */
export interface CheckRequest {
  subject: Subject;
  action: Action;
  resource: Resource;
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
