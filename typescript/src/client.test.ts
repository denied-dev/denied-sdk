import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeniedClient } from "./client";
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
      baseURL: "https://api.denied.dev",
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
      headers: { "X-API-Key": "test-key" },
      timeout: 60000,
    });
  });
});

describe("DeniedClient API Methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.create.mockReturnValue(mockedAxios as any);
  });

  it("should successfully check", async () => {
    mockedAxios.post.mockResolvedValue({
      data: { decision: true, context: { reason: "Policy allows" } },
    });

    const client = new DeniedClient();
    const response = await client.check({
      subjectType: "user",
      subjectId: "alice",
      resourceType: "document",
      resourceId: "1",
      action: "read",
    });

    expect(response.decision).toBe(true);
    expect(response.context?.reason).toBe("Policy allows");
    expect(mockedAxios.post).toHaveBeenCalledWith("/pdp/check", {
      subject: { type: "user", id: "alice", properties: {} },
      resource: { type: "document", id: "1", properties: {} },
      action: { name: "read" },
      context: undefined,
    });
  });

  it("should successfully check with properties", async () => {
    mockedAxios.post.mockResolvedValue({
      data: { decision: false },
    });

    const client = new DeniedClient();
    const response = await client.check({
      subjectType: "user",
      subjectId: "guest",
      subjectProperties: { role: "guest" },
      resourceType: "document",
      resourceId: "secret",
      resourceProperties: { sensitivity: "high" },
      action: "read",
    });

    expect(response.decision).toBe(false);
    expect(mockedAxios.post).toHaveBeenCalledWith("/pdp/check", {
      subject: {
        type: "user",
        id: "guest",
        properties: { role: "guest" },
      },
      resource: {
        type: "document",
        id: "secret",
        properties: { sensitivity: "high" },
      },
      action: { name: "read" },
      context: undefined,
    });
  });

  it("should use 'access' as default action", async () => {
    mockedAxios.post.mockResolvedValue({
      data: { decision: true },
    });

    const client = new DeniedClient();
    await client.check({
      subjectType: "user",
      subjectId: "alice",
      resourceType: "document",
      resourceId: "1",
    });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      "/pdp/check",
      expect.objectContaining({ action: { name: "access" } }),
    );
  });

  it("should successfully bulk check", async () => {
    mockedAxios.post.mockResolvedValue({
      data: [{ decision: true }, { decision: false, context: { reason: "Denied" } }],
    });

    const client = new DeniedClient();
    const requests: CheckRequest[] = [
      {
        subject: {
          type: "user",
          id: "alice",
          properties: {},
        },
        resource: { type: "document", id: "1", properties: {} },
        action: { name: "read" },
      },
      {
        subject: {
          type: "user",
          id: "bob",
          properties: {},
        },
        resource: { type: "document", id: "2", properties: {} },
        action: { name: "write" },
      },
    ];

    const responses = await client.bulkCheck(requests);
    expect(responses).toHaveLength(2);
    expect(responses[0].decision).toBe(true);
    expect(responses[1].decision).toBe(false);
    expect(responses[1].context?.reason).toBe("Denied");
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
        subjectType: "user",
        subjectId: "alice",
        resourceType: "document",
        resourceId: "1",
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
        subjectType: "user",
        subjectId: "alice",
        resourceType: "document",
        resourceId: "1",
      }),
    ).rejects.toThrow("HTTP 500");
  });

  it("should handle network error", async () => {
    mockedAxios.post.mockRejectedValue(new Error("Network error"));

    const client = new DeniedClient();
    await expect(
      client.check({
        subjectType: "user",
        subjectId: "alice",
        resourceType: "document",
        resourceId: "1",
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
        subject: {
          type: "user",
          id: "alice",
          properties: {},
        },
        resource: { type: "document", id: "1", properties: {} },
        action: { name: "read" },
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
      baseURL: "https://api.denied.dev",
      headers: { "X-API-Key": "env-key-123" },
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
      headers: { "X-API-Key": "custom-key" },
      timeout: 60000,
    });
  });

  it("should not include X-API-Key header when no API key is provided", () => {
    delete process.env.DENIED_API_KEY;
    new DeniedClient();
    expect(mockedAxios.create).toHaveBeenCalledWith({
      baseURL: "https://api.denied.dev",
      headers: {},
      timeout: 60000,
    });
  });
});
