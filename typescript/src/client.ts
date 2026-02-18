import axios, { AxiosInstance, AxiosResponse } from "axios";
import type { Action, CheckRequest, CheckResponse } from "./schemas";

/**
 * Options for configuring the DeniedClient
 */
export interface DeniedClientOptions {
  url?: string;
  apiKey?: string;
}

/**
 * A client for interacting with the Denied server.
 */
export class DeniedClient {
  private readonly url: string;
  private readonly apiKey: string | undefined;
  public readonly client: AxiosInstance;

  /**
   * Creates a new DeniedClient instance.
   *
   * @param options - Configuration options for the client
   * @param options.url - The base URL of the Denied server (defaults to process.env.DENIED_URL or "https://api.denied.dev")
   * @param options.apiKey - The API key for authenticating with the decision node (defaults to process.env.DENIED_API_KEY)
   */
  constructor(options: DeniedClientOptions = {}) {
    this.url = options.url || process.env.DENIED_URL || "https://api.denied.dev";
    this.apiKey = options.apiKey || process.env.DENIED_API_KEY;

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["X-API-Key"] = this.apiKey;
    }

    this.client = axios.create({
      baseURL: this.url,
      headers,
      timeout: 60000,
    });
  }

  /**
   * Handles the response from the Denied server.
   *
   * @param response - The axios response to handle
   * @returns The response data
   */
  private handleResponse<T>(response: AxiosResponse<T>): T {
    return response.data;
  }

  /**
   * Check whether a subject has permissions to perform an action on a specific resource.
   *
   * @param options - Options for the check request
   * @param options.subjectType - The type of the subject (e.g., "user", "service")
   * @param options.subjectId - The unique identifier of the subject scoped to the type
   * @param options.resourceType - The type of the resource (e.g., "document", "api")
   * @param options.resourceId - The unique identifier of the resource scoped to the type
   * @param options.subjectProperties - Additional properties of the subject (optional)
   * @param options.resourceProperties - Additional properties of the resource (optional)
   * @param options.action - The action to check permissions for (can be string or Action object, defaults to "access")
   * @param options.context - Additional context for the authorization check (optional)
   * @returns A promise that resolves to the check response
   */
  async check(options: {
    subjectType: string;
    subjectId: string;
    resourceType: string;
    resourceId: string;
    subjectProperties?: Record<string, unknown>;
    resourceProperties?: Record<string, unknown>;
    action?: string | Action;
    context?: Record<string, unknown>;
  }): Promise<CheckResponse> {
    const actionObj: Action =
      typeof options.action === "string" || options.action === undefined
        ? { name: options.action || "access" }
        : options.action;

    const request: CheckRequest = {
      subject: {
        type: options.subjectType,
        id: options.subjectId,
        properties: options.subjectProperties || {},
      },
      resource: {
        type: options.resourceType,
        id: options.resourceId,
        properties: options.resourceProperties || {},
      },
      action: actionObj,
      context: options.context,
    };

    try {
      const response = await this.client.post<CheckResponse>("/pdp/check", request);
      return this.handleResponse(response);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "response" in error) {
        const axiosError = error as { response?: { status: number; data?: unknown } };
        if (axiosError.response && axiosError.response.status) {
          const data = axiosError.response.data
            ? JSON.stringify(axiosError.response.data)
            : "";
          throw new Error(
            `HTTP ${axiosError.response.status}${data ? ": " + data : ""}`,
          );
        }
      }
      throw error;
    }
  }

  /**
   * Perform a set of permission checks in a single request.
   *
   * @param checkRequests - The list of check requests to perform
   * @returns A promise that resolves to the list of check responses
   */
  async bulkCheck(checkRequests: CheckRequest[]): Promise<CheckResponse[]> {
    try {
      const response = await this.client.post<CheckResponse[]>(
        "/pdp/check/bulk",
        checkRequests,
      );
      return this.handleResponse(response);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "response" in error) {
        const axiosError = error as { response?: { status: number; data?: unknown } };
        if (axiosError.response && axiosError.response.status) {
          const data = axiosError.response.data
            ? JSON.stringify(axiosError.response.data)
            : "";
          throw new Error(
            `HTTP ${axiosError.response.status}${data ? ": " + data : ""}`,
          );
        }
      }
      throw error;
    }
  }
}
