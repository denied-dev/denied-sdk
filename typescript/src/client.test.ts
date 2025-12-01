import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import { DeniedClient } from "./client";
import { EntityType } from "./enums";
import type { CheckRequest } from "./schemas";

// Mock axios
vi.mock("axios");
const mockedAxios = vi.mocked(axios, true);

describe("DeniedClient Initialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.create.mockReturnValue(mockedAxios as any);
  });

  it("should initialize with default URL", () => {
    const client = new DeniedClient();
    expect(client).toBeDefined();
    expect(mockedAxios.create).toHaveBeenCalledWith({
      baseURL: "http://localhost:8421",
      headers: {},
      timeout: 60000,
    });
  });

  it("should initialize with custom URL", () => {
    const client = new DeniedClient({ url: "https://api.denied.dev" });
    expect(client).toBeDefined();
    expect(mockedAxios.create).toHaveBeenCalledWith({
      baseURL: "https://api.denied.dev",
      headers: {},
      timeout: 60000,
    });
  });

  it("should initialize with API key", () => {
    const client = new DeniedClient({
      url: "https://api.denied.dev",
      apiKey: "test-key",
    });
    expect(client).toBeDefined();
    expect(mockedAxios.create).toHaveBeenCalledWith({
      baseURL: "https://api.denied.dev",
      headers: { "x-api-key": "test-key" },
      timeout: 60000,
    });
  });
});

describe("DeniedClient API Methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.create.mockReturnValue(mockedAxios as any);
  });

  it("should successfully check with URIs", async () => {
    mockedAxios.post.mockResolvedValue({
      data: { allowed: true, reason: "Policy allows" },
    });

    const client = new DeniedClient();
    const response = await client.check({
      principalUri: "user:alice",
      resourceUri: "doc:1",
      action: "read",
    });

    expect(response.allowed).toBe(true);
    expect(response.reason).toBe("Policy allows");
    expect(mockedAxios.post).toHaveBeenCalledWith("/check", {
      principal: { uri: "user:alice", attributes: {}, type: "principal" },
      resource: { uri: "doc:1", attributes: {}, type: "resource" },
      action: "read",
    });
  });

  it("should successfully check with attributes", async () => {
    mockedAxios.post.mockResolvedValue({
      data: { allowed: false },
    });

    const client = new DeniedClient();
    const response = await client.check({
      principalAttributes: { role: "guest" },
      resourceAttributes: { sensitivity: "high" },
      action: "read",
    });

    expect(response.allowed).toBe(false);
    expect(mockedAxios.post).toHaveBeenCalledWith("/check", {
      principal: {
        uri: undefined,
        attributes: { role: "guest" },
        type: "principal",
      },
      resource: {
        uri: undefined,
        attributes: { sensitivity: "high" },
        type: "resource",
      },
      action: "read",
    });
  });

  it("should use 'access' as default action", async () => {
    mockedAxios.post.mockResolvedValue({
      data: { allowed: true },
    });

    const client = new DeniedClient();
    await client.check({
      principalUri: "user:alice",
      resourceUri: "doc:1",
    });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      "/check",
      expect.objectContaining({ action: "access" }),
    );
  });

  it("should successfully bulk check", async () => {
    mockedAxios.post.mockResolvedValue({
      data: [{ allowed: true }, { allowed: false, reason: "Denied" }],
    });

    const client = new DeniedClient();
    const requests: CheckRequest[] = [
      {
        principal: {
          uri: "user:alice",
          attributes: {},
          type: EntityType.Principal,
        },
        resource: { uri: "doc:1", attributes: {}, type: EntityType.Resource },
        action: "read",
      },
      {
        principal: {
          uri: "user:bob",
          attributes: {},
          type: EntityType.Principal,
        },
        resource: { uri: "doc:2", attributes: {}, type: EntityType.Resource },
        action: "write",
      },
    ];

    const responses = await client.bulkCheck(requests);
    expect(responses).toHaveLength(2);
    expect(responses[0].allowed).toBe(true);
    expect(responses[1].allowed).toBe(false);
    expect(responses[1].reason).toBe("Denied");
  });
});

describe("DeniedClient Error Handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.create.mockReturnValue(mockedAxios as any);
  });

  it("should handle 404 error", async () => {
    const error = {
      isAxiosError: true,
      response: {
        status: 404,
        data: { error: "Not found" },
      },
    };
    mockedAxios.post.mockRejectedValue(error);

    const client = new DeniedClient();
    await expect(
      client.check({
        principalUri: "user:alice",
        resourceUri: "doc:1",
      }),
    ).rejects.toThrow("HTTP 404");
  });

  it("should handle 500 error", async () => {
    const error = {
      isAxiosError: true,
      response: {
        status: 500,
        data: { error: "Internal server error" },
      },
    };
    mockedAxios.post.mockRejectedValue(error);

    const client = new DeniedClient();
    await expect(
      client.check({
        principalUri: "user:alice",
        resourceUri: "doc:1",
      }),
    ).rejects.toThrow("HTTP 500");
  });

  it("should handle network error", async () => {
    mockedAxios.post.mockRejectedValue(new Error("Network error"));

    const client = new DeniedClient();
    await expect(
      client.check({
        principalUri: "user:alice",
        resourceUri: "doc:1",
      }),
    ).rejects.toThrow("Network error");
  });

  it("should handle bulkCheck error", async () => {
    const error = {
      isAxiosError: true,
      response: {
        status: 400,
        data: { error: "Bad request" },
      },
    };
    mockedAxios.post.mockRejectedValue(error);

    const client = new DeniedClient();
    const requests: CheckRequest[] = [
      {
        principal: {
          uri: "user:alice",
          attributes: {},
          type: EntityType.Principal,
        },
        resource: { uri: "doc:1", attributes: {}, type: EntityType.Resource },
        action: "read",
      },
    ];

    await expect(client.bulkCheck(requests)).rejects.toThrow("HTTP 400");
  });
});

describe("DeniedClient Configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.create.mockReturnValue(mockedAxios as any);
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should use DENIED_URL from environment", () => {
    process.env.DENIED_URL = "https://env.denied.dev";
    new DeniedClient();
    expect(mockedAxios.create).toHaveBeenCalledWith({
      baseURL: "https://env.denied.dev",
      headers: {},
      timeout: 60000,
    });
  });

  it("should use DENIED_API_KEY from environment", () => {
    process.env.DENIED_API_KEY = "env-key-123";
    new DeniedClient();
    expect(mockedAxios.create).toHaveBeenCalledWith({
      baseURL: "http://localhost:8421",
      headers: { "x-api-key": "env-key-123" },
      timeout: 60000,
    });
  });

  it("should allow constructor to override environment variables", () => {
    process.env.DENIED_URL = "https://env.denied.dev";
    process.env.DENIED_API_KEY = "env-key";

    new DeniedClient({
      url: "https://custom.denied.dev",
      apiKey: "custom-key",
    });

    expect(mockedAxios.create).toHaveBeenCalledWith({
      baseURL: "https://custom.denied.dev",
      headers: { "x-api-key": "custom-key" },
      timeout: 60000,
    });
  });

  it("should not include x-api-key header when no API key is provided", () => {
    delete process.env.DENIED_API_KEY;
    new DeniedClient();
    expect(mockedAxios.create).toHaveBeenCalledWith({
      baseURL: "http://localhost:8421",
      headers: {},
      timeout: 60000,
    });
  });
});

describe("EntityType", () => {
  it("should have Principal type", () => {
    expect(EntityType.Principal).toBe("principal");
  });

  it("should have Resource type", () => {
    expect(EntityType.Resource).toBe("resource");
  });
});
