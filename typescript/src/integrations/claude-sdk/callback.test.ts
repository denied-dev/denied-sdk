import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeniedClient } from "../../client";
import { createDeniedPermissionCallback } from "./callback";

// Mock the DeniedClient
vi.mock("../../client", () => ({
  DeniedClient: vi.fn().mockImplementation(() => ({
    check: vi.fn(),
  })),
}));

// Suppress console output during tests
vi.spyOn(console, "info").mockImplementation(() => {});
vi.spyOn(console, "debug").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

describe("createDeniedPermissionCallback", () => {
  let mockClient: { check: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = { check: vi.fn() };
    (DeniedClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => mockClient,
    );
  });

  const mockOptions = {
    signal: new AbortController().signal,
    toolUseID: "test-tool-use-id",
  };

  describe("allow behavior", () => {
    it("should return allow when authorization succeeds", async () => {
      mockClient.check.mockResolvedValue({ decision: true });

      const callback = createDeniedPermissionCallback({
        userId: "user-123",
      });

      const result = await callback("Read", { file_path: "/test.txt" }, mockOptions);

      expect(result.behavior).toBe("allow");
      expect(result).toHaveProperty("updatedInput");
      expect(
        (result as { updatedInput: Record<string, unknown> }).updatedInput,
      ).toEqual({
        file_path: "/test.txt",
      });
    });

    it("should pass correct parameters to Denied service", async () => {
      mockClient.check.mockResolvedValue({ decision: true });

      const callback = createDeniedPermissionCallback({
        userId: "user-123",
        subjectProperties: { role: "admin" },
        resourceProperties: { scope: "project" },
      });

      await callback("Write", { file_path: "/test.txt" }, mockOptions);

      expect(mockClient.check).toHaveBeenCalledWith({
        subject: {
          type: "user",
          id: "user-123",
          properties: { user_id: "user-123", role: "admin" },
        },
        action: { name: "create" },
        resource: {
          type: "tool",
          id: "Write",
          properties: {
            tool_name: "Write",
            scope: "project",
            tool_input: { values: { file_path: "/test.txt" } },
          },
        },
        context: undefined,
      });
    });
  });

  describe("deny behavior", () => {
    it("should return deny when authorization fails", async () => {
      mockClient.check.mockResolvedValue({
        decision: false,
        context: {
          reason: "Insufficient permissions",
        },
      });

      const callback = createDeniedPermissionCallback({
        userId: "user-123",
      });

      const result = await callback("Write", { file_path: "/test.txt" }, mockOptions);

      expect(result.behavior).toBe("deny");
      expect((result as { message: string }).message).toBe("Insufficient permissions");
    });

    it("should use default message when no reason provided", async () => {
      mockClient.check.mockResolvedValue({ decision: false });

      const callback = createDeniedPermissionCallback({
        userId: "user-123",
      });

      const result = await callback("Write", { file_path: "/test.txt" }, mockOptions);

      expect(result.behavior).toBe("deny");
      expect((result as { message: string }).message).toBe("Authorization denied");
    });
  });

  describe("fail modes", () => {
    it("should deny when service unavailable in fail-closed mode", async () => {
      mockClient.check.mockRejectedValue(new Error("Network error"));

      const callback = createDeniedPermissionCallback({
        userId: "user-123",
        config: { failMode: "closed", retryAttempts: 0 },
      });

      const result = await callback("Read", {}, mockOptions);

      expect(result.behavior).toBe("deny");
      expect((result as { message: string }).message).toContain(
        "Authorization service unavailable",
      );
    });

    it("should allow when service unavailable in fail-open mode", async () => {
      mockClient.check.mockRejectedValue(new Error("Network error"));

      const callback = createDeniedPermissionCallback({
        userId: "user-123",
        config: { failMode: "open", retryAttempts: 0 },
      });

      const result = await callback("Read", { file_path: "/test.txt" }, mockOptions);

      expect(result.behavior).toBe("allow");
      expect(
        (result as { updatedInput: Record<string, unknown> }).updatedInput,
      ).toEqual({
        file_path: "/test.txt",
      });
    });
  });

  describe("retry logic", () => {
    it("should retry on failure", async () => {
      mockClient.check
        .mockRejectedValueOnce(new Error("Temporary error"))
        .mockResolvedValueOnce({ decision: true });

      const callback = createDeniedPermissionCallback({
        userId: "user-123",
        config: { retryAttempts: 1 },
      });

      const result = await callback("Read", {}, mockOptions);

      expect(result.behavior).toBe("allow");
      expect(mockClient.check).toHaveBeenCalledTimes(2);
    });

    it("should fail after max retries exceeded", async () => {
      mockClient.check.mockRejectedValue(new Error("Persistent error"));

      const callback = createDeniedPermissionCallback({
        userId: "user-123",
        config: { failMode: "closed", retryAttempts: 2 },
      });

      const result = await callback("Read", {}, mockOptions);

      expect(result.behavior).toBe("deny");
      expect(mockClient.check).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });
  });

  describe("configuration", () => {
    it("should use provided DeniedClient", async () => {
      const customClient = { check: vi.fn().mockResolvedValue({ decision: true }) };

      const callback = createDeniedPermissionCallback({
        deniedClient: customClient as unknown as DeniedClient,
        userId: "user-123",
      });

      await callback("Read", {}, mockOptions);

      expect(customClient.check).toHaveBeenCalled();
      expect(DeniedClient).not.toHaveBeenCalled();
    });

    it("should override config with userId/sessionId parameters", async () => {
      mockClient.check.mockResolvedValue({ decision: true });

      const callback = createDeniedPermissionCallback({
        config: { userId: "config-user", sessionId: "config-session" },
        userId: "override-user",
        sessionId: "override-session",
      });

      await callback("Read", {}, mockOptions);

      expect(mockClient.check).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.objectContaining({
            type: "user",
            id: "override-user",
            properties: expect.objectContaining({
              user_id: "override-user",
              session_id: "override-session",
            }),
          }),
        }),
      );
    });
  });

  describe("action mapping", () => {
    it("should map tool names to correct actions", async () => {
      mockClient.check.mockResolvedValue({ decision: true });

      const callback = createDeniedPermissionCallback({
        userId: "user-123",
      });

      await callback("Read", {}, mockOptions);
      expect(mockClient.check).toHaveBeenCalledWith(
        expect.objectContaining({ action: { name: "read" } }),
      );

      await callback("Write", {}, mockOptions);
      expect(mockClient.check).toHaveBeenCalledWith(
        expect.objectContaining({ action: { name: "create" } }),
      );

      await callback("Edit", {}, mockOptions);
      expect(mockClient.check).toHaveBeenCalledWith(
        expect.objectContaining({ action: { name: "update" } }),
      );

      await callback("Bash", {}, mockOptions);
      expect(mockClient.check).toHaveBeenCalledWith(
        expect.objectContaining({ action: { name: "execute" } }),
      );
    });
  });
});
