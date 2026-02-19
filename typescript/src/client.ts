import axios, { AxiosInstance, AxiosResponse } from "axios";
import type {
  ActionLike,
  CheckRequest,
  CheckResponse,
  Resource,
  ResourceLike,
  Subject,
  SubjectLike,
} from "./schemas";

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

  private static coerceSubject(value: SubjectLike): Subject {
    if (typeof value !== "string") return value;
    if (!value.includes("://")) {
      throw new Error(`Invalid subject string '${value}': expected format 'type://id'`);
    }
    const idx = value.indexOf("://");
    return { type: value.slice(0, idx), id: value.slice(idx + 3) };
  }

  private static coerceResource(value: ResourceLike): Resource {
    if (typeof value !== "string") return value;
    if (!value.includes("://")) {
      throw new Error(
        `Invalid resource string '${value}': expected format 'type://id'`,
      );
    }
    const idx = value.indexOf("://");
    return { type: value.slice(0, idx), id: value.slice(idx + 3) };
  }

  private static coerceAction(value: ActionLike): CheckRequest["action"] {
    if (typeof value !== "string") return value;
    return { name: value };
  }

  /**
   * Check whether a subject has permissions to perform an action on a specific resource.
   *
   * @param options - Options for the check request
   * @param options.subject - The subject performing the action (Subject object or "type://id" string)
   * @param options.action - The action to check (Action object or action name string)
   * @param options.resource - The resource being acted on (Resource object or "type://id" string)
   * @param options.context - Additional context for the authorization check (optional)
   * @returns A promise that resolves to the check response
   */
  async check(options: {
    subject: SubjectLike;
    action: ActionLike;
    resource: ResourceLike;
    context?: Record<string, unknown>;
  }): Promise<CheckResponse> {
    const request: CheckRequest = {
      subject: DeniedClient.coerceSubject(options.subject),
      action: DeniedClient.coerceAction(options.action),
      resource: DeniedClient.coerceResource(options.resource),
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
