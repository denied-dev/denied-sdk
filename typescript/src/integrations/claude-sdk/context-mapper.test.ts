import { describe, it, expect } from "vitest";
import { ContextMapper } from "./context-mapper";
import { resolveConfig } from "./config";
import { EntityType } from "../../enums";

describe("ContextMapper", () => {
  describe("extractPrincipal", () => {
    it("should create principal with user ID", () => {
      const config = resolveConfig({ userId: "user-123" });
      const mapper = new ContextMapper(config);

      const principal = mapper.extractPrincipal();

      expect(principal.type).toBe(EntityType.Principal);
      expect(principal.uri).toBe("user:user-123");
      expect(principal.attributes).toEqual({ user_id: "user-123" });
    });

    it("should create principal with session ID", () => {
      const config = resolveConfig({
        userId: "user-123",
        sessionId: "session-456",
      });
      const mapper = new ContextMapper(config);

      const principal = mapper.extractPrincipal();

      expect(principal.attributes).toEqual({
        user_id: "user-123",
        session_id: "session-456",
      });
    });

    it("should use default principal ID when user ID not provided", () => {
      const config = resolveConfig({});
      const mapper = new ContextMapper(config);

      const principal = mapper.extractPrincipal();

      expect(principal.uri).toBe("user:claude-agent");
      expect(principal.attributes).toBeUndefined();
    });

    it("should include custom principal attributes", () => {
      const config = resolveConfig({ userId: "user-123" });
      const mapper = new ContextMapper(config, { role: "admin", team: "engineering" });

      const principal = mapper.extractPrincipal();

      expect(principal.attributes).toEqual({
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

      expect(resource.type).toBe(EntityType.Resource);
      expect(resource.uri).toBe("tool:Read");
      expect(resource.attributes).toEqual({ tool_name: "Read" });
    });

    it("should include tool input when extractToolArgs is true", () => {
      const config = resolveConfig({ extractToolArgs: true });
      const mapper = new ContextMapper(config);

      const resource = mapper.extractResource("Write", {
        file_path: "/test.txt",
        content: "hello",
      });

      expect(resource.attributes).toEqual({
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

      expect(resource.attributes).toEqual({ tool_name: "Write" });
    });

    it("should not include tool input when input is empty", () => {
      const config = resolveConfig({ extractToolArgs: true });
      const mapper = new ContextMapper(config);

      const resource = mapper.extractResource("Read", {});

      expect(resource.attributes).toEqual({ tool_name: "Read" });
    });

    it("should include custom resource attributes", () => {
      const config = resolveConfig({});
      const mapper = new ContextMapper(config, {}, { scope: "project", env: "prod" });

      const resource = mapper.extractResource("Read", {});

      expect(resource.attributes).toEqual({
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

      expect(request.principal.type).toBe(EntityType.Principal);
      expect(request.principal.uri).toBe("user:user-123");
      expect(request.principal.attributes).toEqual({
        user_id: "user-123",
        role: "admin",
      });

      expect(request.resource.type).toBe(EntityType.Resource);
      expect(request.resource.uri).toBe("tool:Write");
      expect(request.resource.attributes).toEqual({
        tool_name: "Write",
        scope: "project",
        tool_input: { values: { file_path: "/test.txt" } },
      });

      expect(request.action).toBe("create"); // Write maps to create
    });

    it("should extract correct action for different tools", () => {
      const config = resolveConfig({});
      const mapper = new ContextMapper(config);

      expect(mapper.createCheckRequest("Read", {}).action).toBe("read");
      expect(mapper.createCheckRequest("Write", {}).action).toBe("create");
      expect(mapper.createCheckRequest("Edit", {}).action).toBe("update");
      expect(mapper.createCheckRequest("Bash", {}).action).toBe("execute");
      expect(mapper.createCheckRequest("delete_file", {}).action).toBe("delete");
    });
  });
});
