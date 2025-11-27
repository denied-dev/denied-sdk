import axios, { AxiosInstance, AxiosResponse } from "axios";
import {
  CheckRequest,
  CheckResponse,
  EntityType,
} from "./index";

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
   * @param options.url - The base URL of the Denied server (defaults to process.env.DENIED_URL or "http://localhost:8080")
   * @param options.apiKey - The API key for authenticating with the server (defaults to process.env.DENIED_API_KEY)
   */
  constructor(options: DeniedClientOptions = {}) {
    this.url = options.url || process.env.DENIED_URL || "http://localhost:8080";
    this.apiKey = options.apiKey || process.env.DENIED_API_KEY;

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
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
    principalAttributes?: Record<string, string>;
    resourceAttributes?: Record<string, string>;
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
      const response = await this.client.post<CheckResponse>(
        "/check",
        request,
      );
      return this.handleResponse(response);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        throw new Error(
          `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`,
        );
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
        "/check/bulk",
        checkRequests,
      );
      return this.handleResponse(response);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        throw new Error(
          `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`,
        );
      }
      throw error;
    }
  }
}
