/* eslint-disable @typescript-eslint/no-explicit-any */
import { EntityType } from "./enums";

/**
 * Base interface for check request entities
 */
export interface EntityCheck {
  uri?: string;
  attributes?: Record<string, any>;
  type: EntityType;
}

/**
 * Resource in a check request
 */
export interface ResourceCheck extends EntityCheck {
  type: EntityType.Resource;
}

/**
 * Principal in a check request
 */
export interface PrincipalCheck extends EntityCheck {
  type: EntityType.Principal;
}

/**
 * Complete request to check permissions
 */
export interface CheckRequest {
  principal: PrincipalCheck;
  resource: ResourceCheck;
  action: string;
}

/**
 * Response from the server when a check request is made
 */
export interface CheckResponse {
  allowed: boolean;
  reason?: string;
}
