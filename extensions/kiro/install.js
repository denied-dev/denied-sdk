#!/usr/bin/env node
// Denied SDK – Kiro installer for the PreToolUse authorization gate.
// Zero dependencies. Requires Node.js 18+ (native fetch for --check).
//
//   node extensions/kiro/install.js [--workspace=<path>] [--dry-run] [--check] [--uninstall]
//
// Kiro has no plugin system (#8578), so installation is: stage the interceptor
// at a stable absolute path, then register one v1 hook file that serves both
// supported surfaces (Kiro IDE and Kiro CLI V3). Kiro CLI V2 is out of scope.
//
// The installer edits a user-authored file (~/.kiro/hooks/denied.json), so every
// file it writes or modifies is recorded in ~/.denied/kiro/install-manifest.json
// (the dotkiro model). That manifest is what makes --uninstall exact and what
// lets a re-run notice the user hand-edited a managed file instead of silently
// overwriting it.
//
// Planning/merge logic is pure and exported for tests; all filesystem roots are
// injectable so the suite runs against temp directories.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PREFIX = "[denied-dev]";
const HOOK_NAME = "denied-authz";
const HOOK_FILENAME = "denied.json";
const INTERCEPTOR_PLACEHOLDER = "__DENIED_INTERCEPTOR_PATH__";
// Legacy `.kiro.hook` files never fire on measured builds, but earlier hand
// installs may have left one behind; --check reports them and --uninstall removes them.
const LEGACY_HOOK_PATTERN = /^denied.*\.kiro\.hook$/i;
const MIN_NODE_MAJOR = 18;
const MIN_KIRO_IDE_VERSION = "1.0.182";
const MANIFEST_VERSION = 1;
const DEFAULT_URL = "https://api.denied.dev";
const PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const USAGE = `Usage: node install.js [options]

  (no options)          Install the Denied gate for Kiro IDE and Kiro CLI V3
  --workspace=<path>    Also register the hook in <path>/.kiro/hooks/
  --dry-run             Print the plan, write nothing
  --check               Verify the gate can actually fire
  --uninstall           Remove the Denied gate (never touches ~/.denied/config.json)
  --help                Show this message`;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    workspace: null,
    dryRun: false,
    check: false,
    uninstall: false,
    help: false,
    unknown: [],
  };
  for (const arg of argv) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--uninstall") opts.uninstall = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--workspace=")) {
      const value = arg.slice("--workspace=".length);
      // An empty value would be silently dropped downstream; reject it loudly.
      if (value) opts.workspace = value;
      else opts.unknown.push(arg);
    } else opts.unknown.push(arg);
  }
  return opts;
}

function expandHome(value, homedir) {
  if (value === "~") return homedir;
  return value.startsWith("~/") ? path.join(homedir, value.slice(2)) : value;
}

// Every path the installer touches, derived from an injected homedir/cwd so the
// hook `command` is always absolute (N10) and tests never see the real $HOME.
function resolvePaths({ homedir, cwd = homedir, workspace = null }) {
  const deniedDir = path.join(homedir, ".denied");
  const deniedKiroDir = path.join(deniedDir, "kiro");
  const globalHooksDir = path.join(homedir, ".kiro", "hooks");

  const hookFiles = [
    { scope: "global", path: path.join(globalHooksDir, HOOK_FILENAME) },
  ];
  if (workspace) {
    const root = path.resolve(cwd, expandHome(workspace, homedir));
    hookFiles.push({
      scope: "workspace",
      path: path.join(root, ".kiro", "hooks", HOOK_FILENAME),
    });
  }

  return {
    deniedDir,
    deniedKiroDir,
    configPath: path.join(deniedDir, "config.json"),
    interceptorTarget: path.join(deniedKiroDir, "interceptor.js"),
    manifestPath: path.join(deniedKiroDir, "install-manifest.json"),
    kiroHome: path.join(homedir, ".kiro"),
    globalHooksDir,
    hookFiles,
  };
}

function hashText(text) {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function parseNodeMajor(versionText) {
  const match = /v?(\d+)\./.exec(String(versionText).trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseKiroIdeVersion(versionText) {
  const match = /(?:^|[^\d])(\d+\.\d+\.\d+)(?:[^\d]|$)/m.exec(String(versionText));
  return match ? match[1] : null;
}

function compareDottedVersions(left, right) {
  const leftParts = String(left).split(".").map(Number);
  const rightParts = String(right).split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

// Renders the v1 template into a single hook entry with an absolute interceptor
// path substituted into the command. `~` is expanded here so no generated
// command can ever depend on shell tilde expansion.
function buildHookEntry(templateRaw, interceptorPath, homedir = os.homedir()) {
  const absolute = path.resolve(expandHome(interceptorPath, homedir));
  if (!path.isAbsolute(absolute)) {
    throw new Error(`Interceptor path is not absolute: ${interceptorPath}`);
  }
  if (absolute.includes('"')) {
    throw new Error(
      `Interceptor path contains a double quote, which cannot be quoted safely in a hook command: ${absolute}`,
    );
  }

  let template;
  try {
    template = JSON.parse(templateRaw);
  } catch (err) {
    throw new Error(`Hook template is not valid JSON: ${err.message}`);
  }
  const entry = Array.isArray(template.hooks) ? template.hooks[0] : null;
  if (!entry || typeof entry !== "object") {
    throw new Error('Hook template has no "hooks" array entry.');
  }
  entry.name = HOOK_NAME;
  entry.action = {
    ...entry.action,
    command: String(entry.action?.command ?? "").split(INTERCEPTOR_PLACEHOLDER)
      .join(absolute),
  };
  if (entry.action.command.includes(INTERCEPTOR_PLACEHOLDER)) {
    throw new Error("Failed to substitute the interceptor path into the hook command.");
  }
  return entry;
}

// Merges our hook entry into an existing `~/.kiro/hooks/denied.json`.
//   absent file    -> create
//   user hooks     -> append ours, leave theirs untouched
//   ours present   -> replace in place, never duplicate
//   malformed file -> refuse; the caller must not write anything
function mergeHookFile(existingRaw, entry) {
  if (existingRaw === null || existingRaw === undefined || existingRaw.trim() === "") {
    return { ok: true, action: "create", data: { version: "v1", hooks: [entry] }, warnings: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(existingRaw);
  } catch (err) {
    return { ok: false, reason: `existing file is not valid JSON (${err.message})` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "existing file is not a JSON object" };
  }
  if (parsed.hooks !== undefined && !Array.isArray(parsed.hooks)) {
    return { ok: false, reason: 'existing file has a "hooks" key that is not an array' };
  }

  const warnings = [];
  if (parsed.version !== undefined && parsed.version !== "v1") {
    warnings.push(
      `existing file declares version ${JSON.stringify(parsed.version)}; leaving it unchanged (Denied writes v1 entries)`,
    );
  }

  const hooks = Array.isArray(parsed.hooks) ? parsed.hooks.slice() : [];
  const index = hooks.findIndex(
    (hook) => hook && typeof hook === "object" && hook.name === HOOK_NAME,
  );
  let action;
  if (index >= 0) {
    hooks[index] = entry;
    action = "replace";
  } else {
    hooks.push(entry);
    action = "add";
  }

  return {
    ok: true,
    action,
    data: { ...parsed, version: parsed.version ?? "v1", hooks },
    warnings,
  };
}

// Inverse of mergeHookFile. `delete` means the file held nothing but our entry.
function removeHookEntry(existingRaw) {
  if (existingRaw === null || existingRaw === undefined) {
    return { ok: true, action: "absent" };
  }

  let parsed;
  try {
    parsed = JSON.parse(existingRaw);
  } catch (err) {
    return { ok: false, reason: `file is not valid JSON (${err.message})` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "file is not a JSON object" };
  }

  const hooks = Array.isArray(parsed.hooks) ? parsed.hooks : [];
  const remaining = hooks.filter(
    (hook) => !(hook && typeof hook === "object" && hook.name === HOOK_NAME),
  );
  if (remaining.length === hooks.length) {
    return { ok: true, action: "absent" };
  }
  if (remaining.length === 0) {
    return { ok: true, action: "delete" };
  }
  return { ok: true, action: "remove", data: { ...parsed, hooks: remaining } };
}

function serializeHookFile(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

// Carries forward entries for files a previous run managed but this one does not
// (e.g. a workspace hook installed earlier), so --uninstall stays exact.
function mergeManifestEntries(previous = [], current = []) {
  const byPath = new Map();
  for (const entry of previous) {
    if (entry && entry.path) byPath.set(entry.path, entry);
  }
  for (const entry of current) {
    if (!entry || !entry.path) continue;
    const prior = byPath.get(entry.path);
    byPath.set(entry.path, {
      ...entry,
      // Keep the earliest backup: it is the user's pre-Denied copy.
      backup: prior?.backup ?? entry.backup ?? null,
    });
  }
  return [...byPath.values()];
}

// Compares recorded hashes against what is on disk now. `readFile` returns the
// file's text or null, which keeps this testable without a filesystem.
function detectDrift(manifest, readFile) {
  const drift = [];
  for (const entry of manifest?.files ?? []) {
    if (!entry || !entry.path || !entry.hash) continue;
    const current = readFile(entry.path);
    if (current === null || current === undefined) {
      drift.push({ path: entry.path, status: "missing" });
    } else if (hashText(current) !== entry.hash) {
      drift.push({ path: entry.path, status: "modified" });
    }
  }
  return drift;
}

function findOnPath(name, env, exists, platform = process.platform) {
  const raw = env.PATH || env.Path || "";
  const extensions = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function runVersionCommand(command, args, env, spawn = spawnSync, platform = process.platform) {
  let result;
  try {
    result = spawn(command, args, {
      encoding: "utf-8",
      env,
      shell: platform === "win32",
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
  } catch (err) {
    return { version: null, error: err.message };
  }
  if (result.error || result.status !== 0) {
    return {
      version: null,
      error: result.error ? result.error.message : `${path.basename(command)} exited ${result.status}`,
    };
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const version = parseKiroIdeVersion(output);
  return version
    ? { version }
    : { version: null, error: `unrecognised version output: ${output.trim() || "<empty>"}` };
}

// Prefer application metadata on macOS so detection works even when Kiro's
// optional shell integration is not on PATH. Elsewhere, the `kiro` shell
// command is the portable signal available to a zero-dependency installer.
function detectKiroIdeVersion({
  env,
  homedir,
  exists = fs.existsSync,
  spawn = spawnSync,
  platform = process.platform,
}) {
  const detected = [];

  if (platform === "darwin") {
    const appPaths = ["/Applications/Kiro.app", path.join(homedir, "Applications", "Kiro.app")];
    for (const appPath of appPaths) {
      if (!exists(appPath)) continue;
      detected.push(appPath);
      const infoPlist = path.join(appPath, "Contents", "Info.plist");
      if (!exists(infoPlist)) continue;
      const probe = runVersionCommand(
        "/usr/bin/plutil",
        ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPlist],
        env,
        spawn,
        platform,
      );
      if (probe.version) return { found: true, path: appPath, version: probe.version };
    }
  }

  const executable = findOnPath("kiro", env, exists, platform);
  if (executable) {
    detected.push(executable);
    const probe = runVersionCommand(executable, ["--version"], env, spawn, platform);
    if (probe.version) return { found: true, path: executable, version: probe.version };
  }

  return detected.length > 0
    ? { found: true, path: detected[0], version: null }
    : { found: false, path: null, version: null };
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

function readTextOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function readJsonOrNull(filePath) {
  const raw = readTextOrNull(filePath);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function listLegacyHooks(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => LEGACY_HOOK_PATTERN.test(name)).map((name) => path.join(dir, name));
}

function backupName(filePath, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return `${filePath}.denied-backup-${stamp}`;
}

function checkNodeOnPath(env) {
  let result;
  try {
    result = spawnSync("node", ["--version"], {
      encoding: "utf-8",
      env,
      shell: process.platform === "win32",
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (result.error || result.status !== 0) {
    return { ok: false, error: result.error ? result.error.message : "node --version failed" };
  }
  const version = String(result.stdout).trim();
  const major = parseNodeMajor(version);
  if (major === null) return { ok: false, error: `unrecognised node version: ${version}` };
  return { ok: major >= MIN_NODE_MAJOR, version, major };
}

function resolveServerUrl(env, configPath) {
  const fileConfig = readJsonOrNull(configPath) ?? {};
  return {
    url: env.DENIED_URL || fileConfig.url || DEFAULT_URL,
    apiKey: env.DENIED_API_KEY || fileConfig.apiKey || "",
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printV2Warning(ctx, kiroCliPath) {
  ctx.blank();
  ctx.out("WARNING: Kiro CLI V2 is not enforced by Denied.");
  ctx.out(`  kiro-cli found at ${kiroCliPath}.`);
  ctx.out("  Sessions started with plain `kiro-cli chat` (V2) bypass this gate entirely.");
  ctx.out("  Run `kiro-cli --v3` for coverage. See README -> Compatibility.");
}

function printRestartInstruction(ctx) {
  ctx.blank();
  ctx.out("REQUIRED: Restart Kiro IDE completely - not just a new chat session.");
  ctx.out("  Hooks are loaded at startup; until you restart, this gate is not active.");
  ctx.out("  An empty Agent Hooks panel does not mean the hook is missing: Kiro may not");
  ctx.out("  re-scan the hooks directory until a filesystem event forces it.");
  ctx.blank();
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function preflight(ctx) {
  const exists = (candidate) => fs.existsSync(candidate);
  return {
    node: checkNodeOnPath(ctx.env),
    hasConfigFile: fs.existsSync(ctx.paths.configPath),
    hasApiKeyEnv: Boolean(ctx.env.DENIED_API_KEY),
    kiroHome: fs.existsSync(ctx.paths.kiroHome),
    kiroCliPath: findOnPath("kiro-cli", ctx.env, exists),
    kiroIde: ctx.detectKiroIdeVersion(),
  };
}

function reportPreflight(ctx, pre) {
  ctx.out("Preflight:");
  ctx.out(
    pre.node.ok
      ? `  node ${pre.node.version} on PATH (>= ${MIN_NODE_MAJOR} required)`
      : `  node: ${pre.node.error ?? `found ${pre.node.version}, need >= ${MIN_NODE_MAJOR}`}`,
  );
  ctx.out(`  ~/.kiro present: ${pre.kiroHome ? "yes" : "no"}`);
  ctx.out(`  kiro-cli on PATH: ${pre.kiroCliPath ? pre.kiroCliPath : "no"}`);
  if (pre.kiroIde.version) {
    const compatibility =
      compareDottedVersions(pre.kiroIde.version, MIN_KIRO_IDE_VERSION) >= 0
        ? "supported"
        : `unsupported; need >= ${MIN_KIRO_IDE_VERSION}`;
    ctx.out(`  Kiro IDE ${pre.kiroIde.version}: ${pre.kiroIde.path} (${compatibility})`);
  } else if (pre.kiroIde.found) {
    ctx.out(`  Kiro IDE application: ${pre.kiroIde.path} (version could not be determined)`);
  } else {
    ctx.out("  Kiro IDE application: not found");
  }
}

async function runInstall(ctx) {
  const { paths } = ctx;
  ctx.out(`Denied authorization gate for Kiro - ${ctx.opts.dryRun ? "install (dry run)" : "install"}`);

  const pre = preflight(ctx);
  reportPreflight(ctx, pre);

  if (!pre.node.ok) {
    ctx.blank();
    ctx.out("ERROR: Node.js 18+ must be on your PATH.");
    ctx.out("  Kiro is a native binary and ships no Node runtime, so the hook command");
    ctx.out("  `node <interceptor>` will not run without one.");
    ctx.out("  Install from https://nodejs.org/ (or `brew install node`), then re-run this installer.");
    return 1;
  }

  if (
    pre.kiroIde.version &&
    compareDottedVersions(pre.kiroIde.version, MIN_KIRO_IDE_VERSION) < 0
  ) {
    ctx.blank();
    ctx.out(`WARNING: Kiro IDE ${pre.kiroIde.version} is not supported by this integration.`);
    ctx.out(`  The v1 hook requires Kiro IDE >= ${MIN_KIRO_IDE_VERSION}.`);
    ctx.out("  Installation can continue for Kiro CLI V3, but this IDE will not be enforced.");
    ctx.out("  Update Kiro IDE, then re-run `--check`.");
  }

  if (!pre.hasConfigFile && !pre.hasApiKeyEnv) {
    ctx.blank();
    ctx.out("WARNING: No Denied API key found.");
    ctx.out(`  Neither DENIED_API_KEY is set nor ${paths.configPath} exists.`);
    ctx.out("  Without a key the interceptor fails open on every tool call - it will");
    ctx.out('  install, but it will not enforce. Create the file with {"apiKey": "..."}.');
  }
  if (!pre.kiroHome) {
    ctx.out(`NOTE: ${paths.kiroHome} does not exist yet; it will be created.`);
  }
  if (pre.kiroCliPath) {
    printV2Warning(ctx, pre.kiroCliPath);
  }

  const blockers = [];
  const interceptorSource = readTextOrNull(ctx.interceptorSource);
  if (interceptorSource === null) {
    blockers.push(`Interceptor not found at ${ctx.interceptorSource}`);
  }
  const templateRaw = readTextOrNull(ctx.templatePath);
  if (templateRaw === null) {
    blockers.push(`Hook template not found at ${ctx.templatePath}`);
  }

  let entry = null;
  if (templateRaw !== null) {
    try {
      entry = buildHookEntry(templateRaw, paths.interceptorTarget, ctx.homedir);
    } catch (err) {
      blockers.push(err.message);
    }
  }

  const stagedCurrent = readTextOrNull(paths.interceptorTarget);
  const interceptorStep = {
    path: paths.interceptorTarget,
    existed: stagedCurrent !== null,
    changed: interceptorSource !== null && stagedCurrent !== interceptorSource,
    content: interceptorSource,
  };

  const hookSteps = [];
  if (entry) {
    for (const hookFile of paths.hookFiles) {
      const existing = readTextOrNull(hookFile.path);
      const merged = mergeHookFile(existing, entry);
      if (!merged.ok) {
        blockers.push(`${hookFile.path}: ${merged.reason}`);
        continue;
      }
      for (const warning of merged.warnings) {
        ctx.out(`NOTE: ${hookFile.path}: ${warning}`);
      }
      const content = serializeHookFile(merged.data);
      hookSteps.push({
        scope: hookFile.scope,
        path: hookFile.path,
        existed: existing !== null,
        changed: existing !== content,
        action: merged.action,
        content,
      });
    }
  }

  const manifest = readJsonOrNull(paths.manifestPath);
  const drift = detectDrift(manifest, readTextOrNull);

  ctx.blank();
  ctx.out("Plan:");
  ctx.out(
    `  interceptor  ${interceptorStep.path}  (${
      !interceptorStep.existed ? "create" : interceptorStep.changed ? "update" : "unchanged"
    })`,
  );
  for (const step of hookSteps) {
    const verb = !step.existed
      ? "create"
      : step.changed
        ? `${step.action} entry "${HOOK_NAME}"`
        : "unchanged";
    ctx.out(`  hook file    ${step.path}  (${verb}) [${step.scope}]`);
  }
  ctx.out(`  manifest     ${paths.manifestPath}  (record what was written)`);

  if (drift.length > 0) {
    ctx.blank();
    for (const item of drift) {
      ctx.out(
        item.status === "missing"
          ? `NOTICE: ${item.path} was removed since Denied installed it; this run restores it.`
          : `NOTICE: ${item.path} changed since Denied installed it (hand-edited or updated by another tool).`,
      );
    }
    ctx.out("  This run updates it anyway; a backup is written first.");
  }

  if (blockers.length > 0) {
    ctx.blank();
    ctx.out("ERROR: refusing to install - nothing was written.");
    for (const blocker of blockers) ctx.out(`  ${blocker}`);
    ctx.out("  Fix or move the file above and re-run. Denied never overwrites a file it cannot parse.");
    return 1;
  }

  if (ctx.opts.dryRun) {
    ctx.blank();
    ctx.out("Dry run: nothing was written.");
    return 0;
  }

  // Apply.
  const written = [];
  fs.mkdirSync(paths.deniedKiroDir, { recursive: true, mode: DIR_MODE });
  fs.chmodSync(paths.deniedKiroDir, DIR_MODE);

  if (interceptorStep.changed || !interceptorStep.existed) {
    fs.writeFileSync(paths.interceptorTarget, interceptorStep.content, { mode: FILE_MODE });
  }
  written.push({
    path: paths.interceptorTarget,
    kind: "interceptor",
    action: interceptorStep.existed ? "modified" : "created",
    changed: interceptorStep.changed || !interceptorStep.existed,
    hash: hashText(interceptorStep.content),
    backup: null,
  });

  for (const step of hookSteps) {
    let backup = null;
    if (step.existed && step.changed) {
      backup = backupName(step.path, ctx.now);
      fs.copyFileSync(step.path, backup);
    }
    if (step.changed) {
      fs.mkdirSync(path.dirname(step.path), { recursive: true });
      fs.writeFileSync(step.path, step.content, "utf-8");
    }
    written.push({
      path: step.path,
      kind: "hook",
      scope: step.scope,
      action: step.existed ? "modified" : "created",
      changed: step.changed,
      hash: hashText(step.content),
      backup,
    });
  }

  const nextManifest = {
    version: MANIFEST_VERSION,
    installedAt: new Date(ctx.now).toISOString(),
    interceptorSource: ctx.interceptorSource,
    files: mergeManifestEntries(
      manifest?.files ?? [],
      written.map(({ changed: _changed, ...entry }) => entry),
    ),
  };
  fs.writeFileSync(paths.manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, {
    mode: FILE_MODE,
  });

  ctx.blank();
  ctx.out("Installed:");
  for (const record of written) {
    const state = record.changed ? record.action : "unchanged";
    ctx.out(`  ${state.padEnd(9)} ${record.path}`);
    if (record.backup) ctx.out(`           backup: ${record.backup}`);
  }
  ctx.out(`  ${"manifest".padEnd(9)} ${paths.manifestPath}`);

  printRestartInstruction(ctx);
  ctx.out("Kiro CLI V3 picks the hook up on the next `kiro-cli --v3` session.");
  ctx.out(`Verify with: node ${ctx.selfPath} --check`);
  return 0;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

async function probePdp(ctx, url, apiKey) {
  const fetchImpl = ctx.fetchImpl;
  if (typeof fetchImpl !== "function") {
    return { ok: false, detail: "fetch is unavailable in this Node runtime" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  const body = {
    subject: { type: "kiro", id: "denied-install-check" },
    action: { name: "execute" },
    resource: { type: "tool", id: "denied-install-check" },
    context: { integration: "denied-kiro-installer" },
  };
  try {
    // Any HTTP response proves reachability; only a transport error does not.
    const response = await fetchImpl(`${url}/pdp/check`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { ok: true, status: response.status };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(ctx) {
  const { paths } = ctx;
  ctx.out("Denied authorization gate for Kiro - check");
  const results = [];
  const record = (ok, label, detail) => {
    results.push({ ok, label, detail });
    ctx.out(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? `: ${detail}` : ""}`);
  };

  const kiroIde = ctx.detectKiroIdeVersion();
  if (kiroIde.version) {
    const supported = compareDottedVersions(kiroIde.version, MIN_KIRO_IDE_VERSION) >= 0;
    record(
      supported,
      "Kiro IDE version",
      supported
        ? `${kiroIde.version} at ${kiroIde.path} (>= ${MIN_KIRO_IDE_VERSION})`
        : `${kiroIde.version} at ${kiroIde.path} is unsupported; update to >= ${MIN_KIRO_IDE_VERSION}`,
    );
  } else if (kiroIde.found) {
    ctx.out(
      `  [WARN] Kiro IDE version: could not determine the version at ${kiroIde.path}; compatibility was not checked`,
    );
  } else {
    ctx.out("  [INFO] Kiro IDE version: IDE not detected; checking the shared hook installation");
  }

  for (const hookFile of paths.hookFiles) {
    const raw = readTextOrNull(hookFile.path);
    if (raw === null) {
      record(false, `hook file (${hookFile.scope})`, `missing: ${hookFile.path}`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      record(false, `hook file (${hookFile.scope})`, `${hookFile.path} is not valid JSON (${err.message})`);
      continue;
    }
    const entry = (Array.isArray(parsed?.hooks) ? parsed.hooks : []).find(
      (hook) => hook && hook.name === HOOK_NAME,
    );
    if (!entry) {
      record(false, `hook file (${hookFile.scope})`, `no "${HOOK_NAME}" entry in ${hookFile.path}`);
      continue;
    }
    if (entry.enabled === false) {
      record(false, `hook file (${hookFile.scope})`, `"${HOOK_NAME}" is present but disabled`);
      continue;
    }
    // Registration alone is not enforcement: an entry with the wrong trigger,
    // the wrong matcher or a command pointing somewhere else is a hook that
    // never gates a tool call, so it must fail rather than warn.
    const wiring = [];
    if (entry.trigger !== "PreToolUse") {
      wiring.push(`trigger=${JSON.stringify(entry.trigger)} - expected "PreToolUse"`);
    }
    if (entry.matcher !== ".*") {
      wiring.push(`matcher=${JSON.stringify(entry.matcher)} - expected ".*"`);
    }
    if (!String(entry.action?.command ?? "").includes(paths.interceptorTarget)) {
      wiring.push(`command does not reference ${paths.interceptorTarget}`);
    }
    if (wiring.length > 0) {
      record(
        false,
        `hook file (${hookFile.scope})`,
        `"${HOOK_NAME}" in ${hookFile.path} is mis-wired and will not gate tool calls (${wiring.join("; ")})`,
      );
      continue;
    }
    record(true, `hook file (${hookFile.scope})`, `${HOOK_NAME} registered in ${hookFile.path}`);
  }

  const staged = readTextOrNull(paths.interceptorTarget);
  record(
    staged !== null,
    "interceptor staged",
    staged !== null ? paths.interceptorTarget : `missing: ${paths.interceptorTarget}`,
  );

  const node = checkNodeOnPath(ctx.env);
  record(
    node.ok,
    "node on PATH",
    node.ok ? `${node.version}` : (node.error ?? `${node.version} is below ${MIN_NODE_MAJOR}`),
  );

  // A missing key is not advisory: the PDP rejects unauthenticated checks, so
  // the interceptor would fail open on every single tool call.
  const { url, apiKey } = resolveServerUrl(ctx.env, paths.configPath);
  record(
    Boolean(apiKey),
    "API key configured",
    apiKey
      ? `from ${ctx.env.DENIED_API_KEY ? "DENIED_API_KEY" : paths.configPath}`
      : `set DENIED_API_KEY or add "apiKey" to ${paths.configPath} - without a key every tool call fails open`,
  );

  // Two distinct questions: did anything answer (transport), and did it accept
  // the check (credentials + server health). Only the second proves the gate
  // can actually get a decision - the interceptor treats *every* non-2xx as an
  // error and resolves it through failMode, so only a 2xx may pass here.
  const probe = await probePdp(ctx, url, apiKey);
  record(
    probe.ok,
    "PDP reachable",
    probe.ok ? `${url} responded HTTP ${probe.status}` : `${url}: ${probe.detail}`,
  );
  if (probe.ok) {
    if (probe.status === 401 || probe.status === 403) {
      record(
        false,
        "PDP accepts checks",
        apiKey
          ? `HTTP ${probe.status} - the PDP rejected the configured API key; checks fail open until it is fixed`
          : `HTTP ${probe.status} - the PDP rejects unauthenticated checks; configure an API key (see above)`,
      );
    } else if (probe.status >= 500) {
      record(
        false,
        "PDP accepts checks",
        `HTTP ${probe.status} - the PDP is returning a server error; checks fail-open until it recovers`,
      );
    } else if (probe.status >= 200 && probe.status < 300) {
      record(true, "PDP accepts checks", `HTTP ${probe.status} from ${url}/pdp/check`);
    } else {
      record(
        false,
        "PDP accepts checks",
        `HTTP ${probe.status} - unexpected response from ${url}/pdp/check; the interceptor treats any non-2xx as an error, so checks fail open - is this URL a Denied PDP?`,
      );
    }
  }

  const legacyDirs = new Set(paths.hookFiles.map((hookFile) => path.dirname(hookFile.path)));
  const legacy = [...legacyDirs].flatMap(listLegacyHooks);
  if (legacy.length > 0) {
    ctx.blank();
    ctx.out("NOTICE: legacy .kiro.hook files found (they do not fire; --uninstall removes them):");
    for (const file of legacy) ctx.out(`  ${file}`);
  }

  const failed = results.filter((result) => !result.ok);
  ctx.blank();
  if (failed.length === 0) {
    ctx.out("Result: the gate is registered and every prerequisite is in place.");
    ctx.out("  This cannot prove a running Kiro IDE has loaded it - hooks register at");
    ctx.out("  startup only, so restart the IDE if you installed while it was open.");
    return 0;
  }
  ctx.out(`Result: NOT enforcing - ${failed.length} check(s) failed.`);
  ctx.out(`  Re-run: node ${ctx.selfPath}`);
  return 1;
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

async function runUninstall(ctx) {
  const { paths } = ctx;
  ctx.out(`Denied authorization gate for Kiro - ${ctx.opts.dryRun ? "uninstall (dry run)" : "uninstall"}`);

  const manifest = readJsonOrNull(paths.manifestPath);
  const manifestHookPaths = (manifest?.files ?? [])
    .filter((entry) => entry && entry.kind === "hook" && entry.path)
    .map((entry) => entry.path);
  const hookPaths = [
    ...new Set([...paths.hookFiles.map((hookFile) => hookFile.path), ...manifestHookPaths]),
  ];

  const actions = [];
  const failures = [];
  for (const hookPath of hookPaths) {
    const raw = readTextOrNull(hookPath);
    const result = removeHookEntry(raw);
    if (!result.ok) {
      failures.push(`${hookPath}: ${result.reason}`);
      continue;
    }
    if (result.action === "absent") continue;
    actions.push(
      result.action === "delete"
        ? { kind: "delete-file", path: hookPath }
        : { kind: "rewrite", path: hookPath, content: serializeHookFile(result.data) },
    );
  }

  const hookDirs = new Set(hookPaths.map((hookPath) => path.dirname(hookPath)));
  for (const legacyPath of [...hookDirs].flatMap(listLegacyHooks)) {
    actions.push({ kind: "delete-file", path: legacyPath, legacy: true });
  }

  const stagedDirExists = fs.existsSync(paths.deniedKiroDir);
  if (stagedDirExists) {
    actions.push({ kind: "delete-dir", path: paths.deniedKiroDir });
  }

  ctx.blank();
  if (actions.length === 0 && failures.length === 0) {
    ctx.out("Nothing to remove - no Denied gate found.");
    return 0;
  }

  ctx.out("Plan:");
  const label = (text) => `  ${text.padEnd(20)}`;
  for (const action of actions) {
    if (action.kind === "rewrite") {
      ctx.out(`${label(`remove "${HOOK_NAME}"`)} ${action.path}  (other hooks preserved)`);
    } else if (action.kind === "delete-file") {
      ctx.out(
        `${label(action.legacy ? "delete legacy hook" : "delete file")} ${action.path}`,
      );
    } else {
      ctx.out(`${label("delete directory")} ${action.path}  (staged interceptor + manifest)`);
    }
  }
  for (const failure of failures) {
    ctx.out(`${label("SKIP (unparseable)")} ${failure}`);
  }

  if (ctx.opts.dryRun) {
    ctx.blank();
    ctx.out("Dry run: nothing was removed.");
    return failures.length > 0 ? 1 : 0;
  }

  for (const action of actions) {
    if (action.kind === "rewrite") {
      fs.writeFileSync(action.path, action.content, "utf-8");
    } else if (action.kind === "delete-file") {
      fs.rmSync(action.path, { force: true });
    } else {
      fs.rmSync(action.path, { recursive: true, force: true });
    }
  }

  ctx.blank();
  ctx.out("Uninstalled.");
  ctx.out(`  Left untouched: ${paths.configPath} (it may hold an API key you still want).`);
  ctx.out("  Backups created by earlier installs are left in place; remove them by hand if unwanted.");
  ctx.blank();
  ctx.out("REQUIRED: Restart Kiro IDE completely - a running IDE keeps the hook it loaded");
  ctx.out("  at startup, so the gate stays active until you restart.");
  ctx.blank();
  if (failures.length > 0) {
    ctx.out("ERROR: some files could not be parsed and were left alone - remove the entry by hand.");
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function run(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const opts = parseArgs(argv);
  const emit = options.log ?? ((line) => process.stdout.write(`${line}\n`));

  if (opts.help) {
    emit(USAGE);
    return 0;
  }
  if (opts.unknown.length > 0) {
    emit(`${PREFIX} Unknown argument(s): ${opts.unknown.join(" ")}`);
    emit(USAGE);
    return 1;
  }
  if (opts.check && opts.uninstall) {
    emit(`${PREFIX} --check and --uninstall are mutually exclusive.`);
    return 1;
  }

  const homedir = options.homedir ?? os.homedir();
  const ctx = {
    opts,
    env: options.env ?? process.env,
    homedir,
    cwd: options.cwd ?? process.cwd(),
    now: options.now ?? Date.now(),
    selfPath: options.selfPath ?? __filename,
    interceptorSource:
      options.interceptorSource ?? path.join(__dirname, "hooks", "interceptor.js"),
    templatePath: options.templatePath ?? path.join(__dirname, "templates", "hook-v1.json"),
    fetchImpl: options.fetch ?? globalThis.fetch,
    detectKiroIdeVersion:
      options.detectKiroIdeVersion ??
      (() =>
        detectKiroIdeVersion({
          env: options.env ?? process.env,
          homedir,
        })),
    out: (line) => emit(`${PREFIX} ${line}`),
    blank: () => emit(""),
  };
  ctx.paths = resolvePaths({
    homedir,
    cwd: ctx.cwd,
    workspace: opts.workspace,
  });

  if (opts.check) return runCheck(ctx);
  if (opts.uninstall) return runUninstall(ctx);
  return runInstall(ctx);
}

if (require.main === module) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stdout.write(
        `${PREFIX} Unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`,
      );
      process.exitCode = 1;
    });
}

module.exports = {
  HOOK_NAME,
  INTERCEPTOR_PLACEHOLDER,
  LEGACY_HOOK_PATTERN,
  MIN_KIRO_IDE_VERSION,
  parseArgs,
  expandHome,
  resolvePaths,
  hashText,
  parseNodeMajor,
  parseKiroIdeVersion,
  compareDottedVersions,
  buildHookEntry,
  mergeHookFile,
  removeHookEntry,
  serializeHookFile,
  mergeManifestEntries,
  detectDrift,
  findOnPath,
  detectKiroIdeVersion,
  run,
};
