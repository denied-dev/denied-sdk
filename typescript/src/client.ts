import axios, { AxiosInstance, AxiosResponse } from "axios";
import { EntityType } from "./enums";
import type { CheckRequest, CheckResponse } from "./schemas";

/**
 * Options for configuring the DeniedClient
 */
export interface DeniedClientOptions {
  url?: string;
  uuid?: string;
  apiKey?: string;
}

/**
 * A client for interacting with the Denied server.
 */
export class DeniedClient {
  private readonly url: string;
  private readonly uuid: string | undefined;
  private readonly apiKey: string | undefined;
  public readonly client: AxiosInstance;

  /**
   * Creates a new DeniedClient instance.
   *
   * @param options - Configuration options for the client
   * @param options.url - The base URL of the Denied server (defaults to process.env.DENIED_URL or "https://api.denied.dev")
   * @param options.uuid - The UUID of the specific decision node to use (defaults to process.env.DENIED_UUID)
   * @param options.apiKey - The API key for authenticating with the decision node (defaults to process.env.DENIED_API_KEY)
   */
  constructor(options: DeniedClientOptions = {}) {
    this.url = options.url || process.env.DENIED_URL || "https://api.denied.dev";
    this.uuid = options.uuid || process.env.DENIED_UUID;
    this.apiKey = options.apiKey || process.env.DENIED_API_KEY;

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["X-API-Key"] = this.apiKey;
    }
    if (this.uuid) {
      headers["X-Decision-Node-UUID"] = this.uuid;
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
   * Check whether a principal has permissions to perform an action on a specific resource.
   *
   * @param options - Options for the check request
   * @param options.principalUri - The identifier of the principal (optional)
   * @param options.resourceUri - The identifier of the resource (optional)
   * @param options.principalAttributes - The attributes of the principal (optional)
   * @param options.resourceAttributes - The attributes of the resource (optional)
   * @param options.action - The action to check permissions for (optional, defaults to "access")
   * @returns A promise that resolves to the check response
   */
  async check(options: {
    principalUri?: string;
    resourceUri?: string;
    principalAttributes?: Record<string, unknown>;
    resourceAttributes?: Record<string, unknown>;
    action?: string;
  }): Promise<CheckResponse> {
    const request: CheckRequest = {
      principal: {
        uri: options.principalUri,
        attributes: options.principalAttributes || {},
        type: EntityType.Principal,
      },
      resource: {
        uri: options.resourceUri,
        attributes: options.resourceAttributes || {},
        type: EntityType.Resource,
      },
      action: options.action || "access",
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
