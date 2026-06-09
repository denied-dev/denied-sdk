#!/usr/bin/env node
// Denied SDK - Hermes Agent hook installer.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const yaml = require("js-yaml");

const DEFAULT_DENIED_URL = "https://api.denied.dev";
const DEFAULT_FAIL_MODE = "open";
const DEFAULT_TIMEOUT_MS = 15_000;
const HOOK_FILENAME = "denied-hermes-hook.js";
const DEFAULT_CONFIG = {
  url: DEFAULT_DENIED_URL,
  apiKey: "${DENIED_API_KEY}",
  failMode: DEFAULT_FAIL_MODE,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  useSemanticMapping: true,
  subjectId: "session",
  request: {
    includeHookPayload: true,
    includeToolInput: true,
    maxContextBytes: 20_000,
  },
  redaction: {
    enabled: true,
    keys: ["api_key", "apikey", "authorization", "password", "secret", "token"],
  },
  audit: {
    enabled: false,
    dir: "~/.hermes/denied-audit",
    includeRawPayload: true,
    includeMappedRequest: true,
    includeDecision: true,
  },
};

function usage() {
  return `Usage: denied-hermes <command> [options]

Commands:
  install      Install or update the Hermes pre_tool_call hook
  status       Show hook installation status
  update       Replace the installed hook script with this package version
  uninstall   Remove the Denied hook registration and installed hook script

Options:
  --data-dir <path>       Hermes data directory (default: ~/.hermes)
  --api-key <key>         Denied API key to store in denied.json
  --url <url>             Denied PDP URL (default: ${DEFAULT_DENIED_URL})
  --fail-mode <mode>      open or closed (default: open)
  --timeout-ms <number>   PDP timeout in milliseconds (default: 15000)
  --yes                  Use non-interactive defaults
  --dry-run              Print planned changes without writing files
  --no-auto-accept       Do not set hooks_auto_accept: true
  -h, --help             Show this help
`;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function pathsFor(dataDir) {
  const hermesDir = path.resolve(expandHome(dataDir || "~/.hermes"));
  return {
    hermesDir,
    hooksDir: path.join(hermesDir, "agent-hooks"),
    installedHook: path.join(hermesDir, "agent-hooks", HOOK_FILENAME),
    deniedConfig: path.join(hermesDir, "denied.json"),
    hermesConfig: path.join(hermesDir, "config.yaml"),
    packagedHook: path.join(__dirname, HOOK_FILENAME),
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = {
    command,
    dataDir: "~/.hermes",
    autoAccept: true,
    yes: false,
    dryRun: false,
  };

  if (command === "-h" || command === "--help") {
    options.command = undefined;
    options.help = true;
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      index += 1;
      if (index >= args.length) throw new Error(`Missing value for ${arg}`);
      return args[index];
    };

    if (arg === "--data-dir") options.dataDir = next();
    else if (arg === "--api-key") options.apiKey = next();
    else if (arg === "--url") options.url = next();
    else if (arg === "--fail-mode") options.failMode = next();
    else if (arg === "--timeout-ms") options.timeoutMs = next();
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-auto-accept") options.autoAccept = false;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function backupPath(filePath) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${filePath}.bak.${timestamp}`;
}

async function readJson(filePath) {
  if (!(await pathExists(filePath))) return {};
  return JSON.parse(await fsp.readFile(filePath, "utf-8"));
}

async function readYaml(filePath) {
  if (!(await pathExists(filePath))) return {};
  const content = await fsp.readFile(filePath, "utf-8");
  return yaml.load(content) || {};
}

function dumpJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function dumpYaml(value) {
  return yaml.dump(value, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
  });
}

async function writeFileWithBackup(filePath, content, options, changes) {
  const exists = await pathExists(filePath);
  const current = exists ? await fsp.readFile(filePath, "utf-8") : undefined;
  if (current === content) {
    changes.push(`unchanged ${filePath}`);
    return;
  }

  if (options.dryRun) {
    changes.push(`${exists ? "would update" : "would create"} ${filePath}`);
    return;
  }

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  if (exists) {
    const backup = backupPath(filePath);
    await fsp.copyFile(filePath, backup);
    changes.push(`backed up ${filePath} to ${backup}`);
  }
  await fsp.writeFile(filePath, content, "utf-8");
  changes.push(`${exists ? "updated" : "created"} ${filePath}`);
}

async function copyHook(paths, options, changes) {
  const source = await fsp.readFile(paths.packagedHook);
  const exists = await pathExists(paths.installedHook);
  const current = exists ? await fsp.readFile(paths.installedHook) : undefined;

  if (current && Buffer.compare(current, source) === 0) {
    changes.push(`unchanged ${paths.installedHook}`);
    return;
  }

  if (options.dryRun) {
    changes.push(`${exists ? "would update" : "would create"} ${paths.installedHook}`);
    return;
  }

  await fsp.mkdir(paths.hooksDir, { recursive: true });
  if (exists) {
    const backup = backupPath(paths.installedHook);
    await fsp.copyFile(paths.installedHook, backup);
    changes.push(`backed up ${paths.installedHook} to ${backup}`);
  }
  await fsp.copyFile(paths.packagedHook, paths.installedHook);
  await fsp.chmod(paths.installedHook, 0o755);
  changes.push(`${exists ? "updated" : "created"} ${paths.installedHook}`);
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function deniedHookCommand(installedHook) {
  return `node ${shellQuote(installedHook)}`;
}

function isDeniedHookEntry(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    typeof entry.command === "string" &&
    entry.command.includes(HOOK_FILENAME)
  );
}

function mergeHermesConfig(config, paths, options) {
  const next = config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
  const hooks = next.hooks && typeof next.hooks === "object" ? { ...next.hooks } : {};
  const currentPreTool = Array.isArray(hooks.pre_tool_call) ? hooks.pre_tool_call : [];

  hooks.pre_tool_call = [
    ...currentPreTool.filter((entry) => !isDeniedHookEntry(entry)),
    {
      matcher: ".*",
      command: deniedHookCommand(paths.installedHook),
      timeout: 15,
    },
  ];
  next.hooks = hooks;

  if (options.autoAccept) {
    next.hooks_auto_accept = true;
  }

  return next;
}

function mergeDeniedConfig(existing, options) {
  const next = {
    ...DEFAULT_CONFIG,
    ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}),
    request: {
      ...DEFAULT_CONFIG.request,
      ...(existing?.request || {}),
    },
    redaction: {
      ...DEFAULT_CONFIG.redaction,
      ...(existing?.redaction || {}),
    },
    audit: {
      ...DEFAULT_CONFIG.audit,
      ...(existing?.audit || {}),
    },
  };

  if (options.url) next.url = options.url;
  if (options.apiKey) next.apiKey = options.apiKey;
  if (options.failMode) next.failMode = options.failMode;
  if (options.timeoutMs) next.timeoutMs = Number(options.timeoutMs);

  return next;
}

function validateOptions(options) {
  if (options.failMode && !["open", "closed"].includes(options.failMode)) {
    throw new Error("--fail-mode must be either open or closed");
  }
  if (options.timeoutMs && (!Number.isFinite(Number(options.timeoutMs)) || Number(options.timeoutMs) <= 0)) {
    throw new Error("--timeout-ms must be a positive number");
  }
}

async function promptForApiKey(existingConfig, options) {
  if (
    options.apiKey ||
    options.yes ||
    (existingConfig.apiKey && existingConfig.apiKey !== "${DENIED_API_KEY}")
  ) {
    return options;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question("Denied API key (leave empty to use ${DENIED_API_KEY}): ");
    if (answer.trim()) {
      return { ...options, apiKey: answer.trim() };
    }
    return options;
  } finally {
    rl.close();
  }
}

async function install(options) {
  validateOptions(options);
  const paths = pathsFor(options.dataDir);
  const changes = [];
  const existingDeniedConfig = await readJson(paths.deniedConfig);
  const promptedOptions = await promptForApiKey(existingDeniedConfig, options);
  const deniedConfig = mergeDeniedConfig(existingDeniedConfig, promptedOptions);
  const hermesConfig = mergeHermesConfig(await readYaml(paths.hermesConfig), paths, promptedOptions);

  if (options.dryRun) {
    changes.push(`would ensure directory ${paths.hooksDir}`);
  } else {
    await fsp.mkdir(paths.hooksDir, { recursive: true });
  }

  await copyHook(paths, promptedOptions, changes);
  await writeFileWithBackup(paths.deniedConfig, dumpJson(deniedConfig), promptedOptions, changes);
  await writeFileWithBackup(paths.hermesConfig, dumpYaml(hermesConfig), promptedOptions, changes);

  if (!deniedConfig.apiKey || deniedConfig.apiKey === "${DENIED_API_KEY}") {
    changes.push("set DENIED_API_KEY before running Hermes, or update denied.json with an apiKey");
  }

  return changes;
}

async function update(options) {
  const paths = pathsFor(options.dataDir);
  const changes = [];
  await copyHook(paths, options, changes);
  return changes;
}

async function uninstall(options) {
  const paths = pathsFor(options.dataDir);
  const changes = [];

  if (await pathExists(paths.hermesConfig)) {
    const config = await readYaml(paths.hermesConfig);
    const next = config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
    if (next.hooks && typeof next.hooks === "object") {
      const hooks = { ...next.hooks };
      if (Array.isArray(hooks.pre_tool_call)) {
        hooks.pre_tool_call = hooks.pre_tool_call.filter((entry) => !isDeniedHookEntry(entry));
      }
      next.hooks = hooks;
    }
    await writeFileWithBackup(paths.hermesConfig, dumpYaml(next), options, changes);
  } else {
    changes.push(`missing ${paths.hermesConfig}`);
  }

  if (await pathExists(paths.installedHook)) {
    if (options.dryRun) {
      changes.push(`would remove ${paths.installedHook}`);
    } else {
      await fsp.rm(paths.installedHook, { force: true });
      changes.push(`removed ${paths.installedHook}`);
    }
  } else {
    changes.push(`missing ${paths.installedHook}`);
  }

  changes.push(`left ${paths.deniedConfig} in place`);
  return changes;
}

async function status(options) {
  const paths = pathsFor(options.dataDir);
  const hermesConfig = await readYaml(paths.hermesConfig);
  const preTool = hermesConfig?.hooks?.pre_tool_call;
  const hookEntries = Array.isArray(preTool) ? preTool.filter(isDeniedHookEntry) : [];
  const deniedConfig = await readJson(paths.deniedConfig);
  const hookInstalled = await pathExists(paths.installedHook);
  const configInstalled = await pathExists(paths.deniedConfig);
  const hermesConfigInstalled = await pathExists(paths.hermesConfig);
  const hasApiKey =
    Boolean(deniedConfig.apiKey && deniedConfig.apiKey !== "${DENIED_API_KEY}") ||
    Boolean(process.env.DENIED_API_KEY);

  return [
    `Hermes data dir: ${paths.hermesDir}`,
    `Hook file: ${hookInstalled ? "installed" : "missing"} (${paths.installedHook})`,
    `Denied config: ${configInstalled ? "present" : "missing"} (${paths.deniedConfig})`,
    `Hermes config: ${hermesConfigInstalled ? "present" : "missing"} (${paths.hermesConfig})`,
    `Hook registration: ${hookEntries.length > 0 ? "present" : "missing"}`,
    `API key: ${hasApiKey ? "configured" : "missing"}`,
  ];
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.command || options.help) {
    log(usage().trimEnd());
    return;
  }

  let messages;
  if (options.command === "install") messages = await install(options);
  else if (options.command === "status") messages = await status(options);
  else if (options.command === "update") messages = await update(options);
  else if (options.command === "uninstall") messages = await uninstall(options);
  else throw new Error(`Unknown command: ${options.command}`);

  for (const message of messages) log(message);
}

module.exports = {
  DEFAULT_CONFIG,
  deniedHookCommand,
  install,
  main,
  mergeDeniedConfig,
  mergeHermesConfig,
  parseArgs,
  pathsFor,
  status,
  uninstall,
  update,
};

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[denied-hermes] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
