import { describe, it, expect } from "vitest";
import { DeniedClient } from "./client";
import { EntityType } from "./enums";

describe("DeniedClient", () => {
  it("should initialize with default URL", () => {
    const client = new DeniedClient();
    expect(client).toBeDefined();
  });

  it("should initialize with custom URL", () => {
    const client = new DeniedClient({ url: "https://api.denied.dev" });
    expect(client).toBeDefined();
  });

  it("should initialize with API key", () => {
    const client = new DeniedClient({
      url: "https://api.denied.dev",
      apiKey: "test-key",
    });
    expect(client).toBeDefined();
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
