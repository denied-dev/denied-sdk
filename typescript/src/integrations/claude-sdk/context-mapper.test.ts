import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config";
import { ContextMapper } from "./context-mapper";

describe("ContextMapper", () => {
  describe("extractSubject", () => {
    it("should create subject with user ID", () => {
      const config = resolveConfig({ userId: "user-123" });
      const mapper = new ContextMapper(config);

      const subject = mapper.extractSubject();

      expect(subject.type).toBe("user");
      expect(subject.id).toBe("user-123");
      expect(subject.properties).toEqual({ user_id: "user-123" });
    });

    it("should create subject with session ID", () => {
      const config = resolveConfig({
        userId: "user-123",
        sessionId: "session-456",
      });
      const mapper = new ContextMapper(config);

      const subject = mapper.extractSubject();

      expect(subject.properties).toEqual({
        user_id: "user-123",
        session_id: "session-456",
      });
    });

    it("should use default subject ID when user ID not provided", () => {
      const config = resolveConfig({});
      const mapper = new ContextMapper(config);

      const subject = mapper.extractSubject();

      expect(subject.type).toBe("user");
      expect(subject.id).toBe("claude-agent");
      expect(subject.properties).toBeUndefined();
    });

    it("should include custom subject properties", () => {
      const config = resolveConfig({ userId: "user-123" });
      const mapper = new ContextMapper(config, { role: "admin", team: "engineering" });

      const subject = mapper.extractSubject();

      expect(subject.properties).toEqual({
        user_id: "user-123",
        role: "admin",
        team: "engineering",
      });
    });
  });

  describe("extractResource", () => {
    it("should create resource with tool name", () => {
      const config = resolveConfig({});
      const mapper = new ContextMapper(config);

      const resource = mapper.extractResource("Read", {});

      expect(resource.type).toBe("tool");
      expect(resource.id).toBe("Read");
      expect(resource.properties).toEqual({ tool_name: "Read" });
    });

    it("should include tool input when extractToolArgs is true", () => {
      const config = resolveConfig({ extractToolArgs: true });
      const mapper = new ContextMapper(config);

      const resource = mapper.extractResource("Write", {
        file_path: "/test.txt",
        content: "hello",
      });

      expect(resource.properties).toEqual({
        tool_name: "Write",
        tool_input: {
          values: {
            file_path: "/test.txt",
            content: "hello",
          },
        },
      });
    });

    it("should not include tool input when extractToolArgs is false", () => {
      const config = resolveConfig({ extractToolArgs: false });
      const mapper = new ContextMapper(config);

      const resource = mapper.extractResource("Write", {
        file_path: "/test.txt",
        content: "hello",
      });

      expect(resource.properties).toEqual({ tool_name: "Write" });
    });

    it("should not include tool input when input is empty", () => {
      const config = resolveConfig({ extractToolArgs: true });
      const mapper = new ContextMapper(config);

      const resource = mapper.extractResource("Read", {});

      expect(resource.properties).toEqual({ tool_name: "Read" });
    });

    it("should include custom resource properties", () => {
      const config = resolveConfig({});
      const mapper = new ContextMapper(config, {}, { scope: "project", env: "prod" });

      const resource = mapper.extractResource("Read", {});

      expect(resource.properties).toEqual({
        tool_name: "Read",
        scope: "project",
        env: "prod",
      });
    });
  });

  describe("createCheckRequest", () => {
    it("should create complete check request", () => {
      const config = resolveConfig({ userId: "user-123" });
      const mapper = new ContextMapper(config, { role: "admin" }, { scope: "project" });

      const request = mapper.createCheckRequest("Write", {
        file_path: "/test.txt",
      });

      expect(request.subject.type).toBe("user");
      expect(request.subject.id).toBe("user-123");
      expect(request.subject.properties).toEqual({
        user_id: "user-123",
        role: "admin",
      });

      expect(request.resource.type).toBe("tool");
      expect(request.resource.id).toBe("Write");
      expect(request.resource.properties).toEqual({
        tool_name: "Write",
        scope: "project",
        tool_input: { values: { file_path: "/test.txt" } },
      });

      expect(request.action.name).toBe("create"); // Write maps to create
    });

    it("should extract correct action for different tools", () => {
      const config = resolveConfig({});
      const mapper = new ContextMapper(config);

      expect(mapper.createCheckRequest("Read", {}).action.name).toBe("read");
      expect(mapper.createCheckRequest("Write", {}).action.name).toBe("create");
      expect(mapper.createCheckRequest("Edit", {}).action.name).toBe("update");
      expect(mapper.createCheckRequest("Bash", {}).action.name).toBe("execute");
      expect(mapper.createCheckRequest("delete_file", {}).action.name).toBe("delete");
    });
  });
});
