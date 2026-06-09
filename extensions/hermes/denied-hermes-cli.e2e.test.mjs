import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const {
  install,
  status,
  uninstall,
  update,
} = require("./denied-hermes-cli.js");

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "denied-hermes-installer-"));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf-8"));
}

async function readYaml(filePath) {
  return yaml.load(await fs.readFile(filePath, "utf-8"));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("Hermes installer CLI", () => {
  it("installs the hook and config into a fresh Hermes data dir", async () => {
    const dataDir = await tempDataDir();
    try {
      const changes = await install({
        dataDir,
        yes: true,
        apiKey: "test-api-key",
        url: "https://pdp.test",
        failMode: "closed",
        timeoutMs: "1234",
        autoAccept: true,
      });

      const hookPath = path.join(dataDir, "agent-hooks", "denied-hermes-hook.js");
      const deniedConfig = await readJson(path.join(dataDir, "denied.json"));
      const hermesConfig = await readYaml(path.join(dataDir, "config.yaml"));
      const hookMode = (await fs.stat(hookPath)).mode & 0o777;

      expect(changes.join("\n")).toContain("created");
      expect(await exists(hookPath)).toBe(true);
      expect(hookMode & 0o111).not.toBe(0);
      expect(deniedConfig).toMatchObject({
        url: "https://pdp.test",
        apiKey: "test-api-key",
        failMode: "closed",
        timeoutMs: 1234,
        useSemanticMapping: true,
        request: {
          includeHookPayload: true,
          includeToolInput: true,
          maxContextBytes: 20000,
        },
      });
      expect(hermesConfig.hooks_auto_accept).toBe(true);
      expect(hermesConfig.hooks.pre_tool_call).toEqual([
        {
          matcher: ".*",
          command: `node ${hookPath}`,
          timeout: 15,
        },
      ]);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("is idempotent on repeated install", async () => {
    const dataDir = await tempDataDir();
    try {
      await install({
        dataDir,
        yes: true,
        apiKey: "test-api-key",
        autoAccept: true,
      });
      const changes = await install({
        dataDir,
        yes: true,
        apiKey: "test-api-key",
        autoAccept: true,
      });

      const hermesConfig = await readYaml(path.join(dataDir, "config.yaml"));
      expect(changes.every((change) => change.startsWith("unchanged"))).toBe(true);
      expect(hermesConfig.hooks.pre_tool_call).toHaveLength(1);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("merges with existing Hermes config and preserves unrelated settings", async () => {
    const dataDir = await tempDataDir();
    try {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(
        path.join(dataDir, "config.yaml"),
        yaml.dump({
          model: "hermes-test",
          hooks: {
            post_tool_call: [{ matcher: ".*", command: "echo done" }],
            pre_tool_call: [{ matcher: "read.*", command: "echo existing", timeout: 3 }],
          },
        }),
        "utf-8",
      );

      await install({
        dataDir,
        yes: true,
        apiKey: "test-api-key",
        autoAccept: true,
      });

      const hermesConfig = await readYaml(path.join(dataDir, "config.yaml"));
      expect(hermesConfig.model).toBe("hermes-test");
      expect(hermesConfig.hooks.post_tool_call).toEqual([
        { matcher: ".*", command: "echo done" },
      ]);
      expect(hermesConfig.hooks.pre_tool_call).toHaveLength(2);
      expect(hermesConfig.hooks.pre_tool_call[0]).toEqual({
        matcher: "read.*",
        command: "echo existing",
        timeout: 3,
      });
      expect(hermesConfig.hooks.pre_tool_call[1].command).toContain(
        "denied-hermes-hook.js",
      );
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("reports status for installed and configured hook", async () => {
    const dataDir = await tempDataDir();
    try {
      await install({
        dataDir,
        yes: true,
        apiKey: "test-api-key",
        autoAccept: true,
      });

      const lines = await status({ dataDir });

      expect(lines).toContainEqual(expect.stringContaining("Hook file: installed"));
      expect(lines).toContainEqual(expect.stringContaining("Denied config: present"));
      expect(lines).toContainEqual(expect.stringContaining("Hook registration: present"));
      expect(lines).toContainEqual(expect.stringContaining("API key: configured"));
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("updates the hook file without changing denied.json", async () => {
    const dataDir = await tempDataDir();
    try {
      await install({
        dataDir,
        yes: true,
        apiKey: "test-api-key",
        autoAccept: true,
      });
      const configPath = path.join(dataDir, "denied.json");
      const beforeConfig = await fs.readFile(configPath, "utf-8");
      const hookPath = path.join(dataDir, "agent-hooks", "denied-hermes-hook.js");
      await fs.writeFile(hookPath, "old hook", "utf-8");

      const changes = await update({ dataDir, dryRun: false });

      expect(changes.join("\n")).toContain("updated");
      expect(await fs.readFile(configPath, "utf-8")).toBe(beforeConfig);
      expect(await fs.readFile(hookPath, "utf-8")).toContain(
        "Denied SDK - Hermes Agent pre_tool_call shell hook",
      );
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("uninstalls only the hook registration and installed hook file", async () => {
    const dataDir = await tempDataDir();
    try {
      await install({
        dataDir,
        yes: true,
        apiKey: "test-api-key",
        autoAccept: true,
      });

      const changes = await uninstall({ dataDir, dryRun: false });
      const hermesConfig = await readYaml(path.join(dataDir, "config.yaml"));

      expect(changes.join("\n")).toContain("removed");
      expect(await exists(path.join(dataDir, "agent-hooks", "denied-hermes-hook.js"))).toBe(
        false,
      );
      expect(await exists(path.join(dataDir, "denied.json"))).toBe(true);
      expect(hermesConfig.hooks.pre_tool_call).toEqual([]);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("dry-run install does not write files", async () => {
    const dataDir = await tempDataDir();
    try {
      const changes = await install({
        dataDir,
        yes: true,
        dryRun: true,
        apiKey: "test-api-key",
        autoAccept: true,
      });

      expect(changes.join("\n")).toContain("would create");
      expect(await exists(path.join(dataDir, "agent-hooks", "denied-hermes-hook.js"))).toBe(
        false,
      );
      expect(await exists(path.join(dataDir, "denied.json"))).toBe(false);
      expect(await exists(path.join(dataDir, "config.yaml"))).toBe(false);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
