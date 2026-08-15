// Tests for the Kiro installer's pure planning/merge logic, plus end-to-end
// install/uninstall runs against temp directories.
// Run with: node --test (Node 18+, zero dependencies).

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  HOOK_NAME,
  parseArgs,
  expandHome,
  resolvePaths,
  buildHookEntry,
  mergeHookFile,
  removeHookEntry,
  serializeHookFile,
  mergeManifestEntries,
  detectDrift,
  findOnPath,
  parseNodeMajor,
  parseKiroVersion,
  compareVersions,
  kiroIdeAppCandidates,
  detectKiroIdeVersion,
  detectKiroIde,
  parseKiroVersionOutput,
  MIN_KIRO_IDE_VERSION,
  KIRO_IDE_HOOKS_VERSION,
  run,
} = require("./install.js");

const TEMPLATE_PATH = path.join(__dirname, "templates", "hook-v1.json");
const TEMPLATE_RAW = fs.readFileSync(TEMPLATE_PATH, "utf-8");
const INTERCEPTOR_BODY = "// fake staged interceptor\n";

// A claim the installer must never make: V2 is out of scope and unenforced.
const FORBIDDEN_CLAIMS = [
  /V2 (is |are )?(now )?(protected|covered|enforced)/i,
  /all (kiro )?surfaces (are )?(protected|covered|enforced)/i,
];

function makeEntry(interceptorPath = "/home/dev/.denied/kiro/interceptor.js") {
  return buildHookEntry(TEMPLATE_RAW, interceptorPath, "/home/dev");
}

// Builds an isolated $HOME plus a fake source checkout so no test ever reads or
// writes the developer's real Kiro or Denied configuration.
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "denied-kiro-install-"));
  const homedir = path.join(root, "home");
  const source = path.join(root, "source");
  fs.mkdirSync(homedir, { recursive: true });
  fs.mkdirSync(path.join(source, "hooks"), { recursive: true });
  const interceptorSource = path.join(source, "hooks", "interceptor.js");
  fs.writeFileSync(interceptorSource, INTERCEPTOR_BODY);
  return { root, homedir, source, interceptorSource };
}

// IDE detection reads absolute system paths (/Applications/Kiro.app and
// friends) that a temp sandbox cannot isolate, so every run injects a detection
// result. `null` (no IDE found) is the hermetic default; tests that care about
// the version condition pass their own.
async function runInstaller(sandbox, argv = [], overrides = {}) {
  const lines = [];
  const code = await run({
    argv,
    homedir: sandbox.homedir,
    cwd: sandbox.root,
    platform: overrides.platform ?? "linux",
    env: { PATH: process.env.PATH, ...(overrides.env ?? {}) },
    now: overrides.now ?? Date.UTC(2026, 7, 4, 12, 0, 0),
    interceptorSource: overrides.interceptorSource ?? sandbox.interceptorSource,
    templatePath: TEMPLATE_PATH,
    selfPath: "/repo/extensions/kiro/install.js",
    fetch: overrides.fetch,
    detectKiroIde: "detectKiroIde" in overrides ? overrides.detectKiroIde : null,
    log: (line) => lines.push(line),
  });
  return { code, output: lines.join("\n"), lines };
}

function fakeIde(version, appPath = "/Applications/Kiro.app") {
  return { version, parsed: parseKiroVersion(version), appPath };
}

function globalHookPath(sandbox) {
  return path.join(sandbox.homedir, ".kiro", "hooks", "denied.json");
}

function manifestPath(sandbox) {
  return path.join(sandbox.homedir, ".denied", "kiro", "install-manifest.json");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function listFilesRecursively(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found.sort();
}

// ---------------------------------------------------------------------------
// Argument and path helpers
// ---------------------------------------------------------------------------

test("parseArgs reads every documented flag", () => {
  assert.deepEqual(parseArgs(["--dry-run", "--workspace=/tmp/proj"]), {
    workspace: "/tmp/proj",
    dryRun: true,
    check: false,
    uninstall: false,
    help: false,
    unknown: [],
  });
  assert.equal(parseArgs(["--check"]).check, true);
  assert.equal(parseArgs(["--uninstall"]).uninstall, true);
  assert.deepEqual(parseArgs(["--nope"]).unknown, ["--nope"]);
});

test("parseNodeMajor reads a `node --version` string", () => {
  assert.equal(parseNodeMajor("v18.20.4\n"), 18);
  assert.equal(parseNodeMajor("v22.1.0"), 22);
  assert.equal(parseNodeMajor("not a version"), null);
});

// ---------------------------------------------------------------------------
// Kiro IDE version detection
// ---------------------------------------------------------------------------

test("parseKiroVersion reads the IDE's package.json version field", () => {
  assert.deepEqual(parseKiroVersion("1.0.293"), [1, 0, 293]);
  assert.deepEqual(parseKiroVersion("  0.12.333\n"), [0, 12, 333]);
  assert.deepEqual(parseKiroVersion("1.0"), [1, 0, 0], "a two-part version means patch 0");
  assert.equal(parseKiroVersion("not.a.version"), null);
  assert.equal(parseKiroVersion(""), null);
  assert.equal(parseKiroVersion(undefined), null);
  assert.equal(parseKiroVersion(null), null);
  assert.equal(parseKiroVersion({ version: "1.0.0" }), null);
});

test("compareVersions orders the versions the gate depends on", () => {
  const min = parseKiroVersion(MIN_KIRO_IDE_VERSION);
  const hooks = parseKiroVersion(KIRO_IDE_HOOKS_VERSION);
  assert.ok(compareVersions(parseKiroVersion("0.12.333"), hooks) < 0);
  assert.ok(compareVersions(parseKiroVersion("1.0.0"), hooks) === 0);
  assert.ok(compareVersions(parseKiroVersion("1.0.181"), min) < 0);
  assert.ok(compareVersions(parseKiroVersion("1.0.182"), min) === 0);
  assert.ok(compareVersions(parseKiroVersion("1.0.293"), min) > 0);
  assert.ok(compareVersions(parseKiroVersion("2.0.0"), parseKiroVersion("1.99.99")) > 0);
  assert.equal(compareVersions(parseKiroVersion("1.0"), parseKiroVersion("1.0.0")), 0);
});

test("kiroIdeAppCandidates covers the stock install locations per platform", () => {
  const darwin = kiroIdeAppCandidates({ platform: "darwin", homedir: "/Users/dev", env: {} });
  assert.deepEqual(
    darwin.map((candidate) => candidate.packageJsonPath),
    [
      "/Applications/Kiro.app/Contents/Resources/app/package.json",
      "/Users/dev/Applications/Kiro.app/Contents/Resources/app/package.json",
    ],
  );
  assert.equal(darwin[0].appPath, "/Applications/Kiro.app");

  const linux = kiroIdeAppCandidates({ platform: "linux", homedir: "/home/dev", env: {} });
  assert.deepEqual(
    linux.map((candidate) => candidate.packageJsonPath),
    [
      "/usr/share/kiro/resources/app/package.json",
      "/opt/Kiro/resources/app/package.json",
    ],
  );

  const win = kiroIdeAppCandidates({
    platform: "win32",
    homedir: "C:\\Users\\dev",
    env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local", ProgramFiles: "C:\\Program Files" },
  });
  assert.deepEqual(
    win.map((candidate) => candidate.packageJsonPath),
    [
      path.join("C:\\Users\\dev\\AppData\\Local", "Programs", "Kiro", "resources", "app", "package.json"),
      path.join("C:\\Program Files", "Kiro", "resources", "app", "package.json"),
    ],
  );
});

test("kiroIdeAppCandidates skips Windows candidates whose env var is unset", () => {
  assert.deepEqual(kiroIdeAppCandidates({ platform: "win32", homedir: "C:\\", env: {} }), []);
  const onlyProgramFiles = kiroIdeAppCandidates({
    platform: "win32",
    homedir: "C:\\",
    env: { ProgramFiles: "C:\\Program Files" },
  });
  assert.equal(onlyProgramFiles.length, 1);
  assert.match(onlyProgramFiles[0].packageJsonPath, /Program Files/);
});

test("detectKiroIdeVersion reads the version from the first usable candidate", () => {
  const files = {
    "/Applications/Kiro.app/Contents/Resources/app/package.json": '{"name":"kiro","version":"1.0.293"}',
    "/Users/dev/Applications/Kiro.app/Contents/Resources/app/package.json": '{"version":"0.9.0"}',
  };
  assert.deepEqual(
    detectKiroIdeVersion({
      platform: "darwin",
      homedir: "/Users/dev",
      env: {},
      readFile: (file) => files[file] ?? null,
    }),
    {
      version: "1.0.293",
      parsed: [1, 0, 293],
      source: "app",
      appPath: "/Applications/Kiro.app",
    },
  );
});

test("detectKiroIdeVersion skips a malformed candidate in favour of a later one", () => {
  const readFile = (file) => {
    if (file === "/usr/share/kiro/resources/app/package.json") return "{ not json";
    if (file === "/opt/Kiro/resources/app/package.json") return '{"version":"1.0.182"}';
    return null;
  };
  assert.deepEqual(
    detectKiroIdeVersion({ platform: "linux", homedir: "/home/dev", env: {}, readFile }),
    { version: "1.0.182", parsed: [1, 0, 182], source: "app", appPath: "/opt/Kiro" },
  );
});

test("detectKiroIdeVersion reports a found-but-unreadable bundle distinctly", () => {
  // Present on disk with an unusable version field: reporting this as "no IDE
  // installed" would hide an IDE whose compatibility is genuinely unknown.
  assert.deepEqual(
    detectKiroIdeVersion({
      platform: "linux",
      homedir: "/home/dev",
      env: {},
      readFile: (file) =>
        file === "/usr/share/kiro/resources/app/package.json" ? '{"name":"kiro"}' : null,
    }),
    { unreadable: true, appPath: "/usr/share/kiro" },
  );

  // Same for package.json text that is not JSON at all.
  assert.deepEqual(
    detectKiroIdeVersion({
      platform: "linux",
      homedir: "/home/dev",
      env: {},
      readFile: (file) =>
        file === "/opt/Kiro/resources/app/package.json" ? "{ not json" : null,
    }),
    { unreadable: true, appPath: "/opt/Kiro" },
  );
});

test("detectKiroIdeVersion prefers a later usable candidate over an unreadable one", () => {
  assert.deepEqual(
    detectKiroIdeVersion({
      platform: "linux",
      homedir: "/home/dev",
      env: {},
      readFile: (file) => {
        if (file === "/usr/share/kiro/resources/app/package.json") return '{"name":"kiro"}';
        if (file === "/opt/Kiro/resources/app/package.json") return '{"version":"1.0.200"}';
        return null;
      },
    }),
    { version: "1.0.200", parsed: [1, 0, 200], source: "app", appPath: "/opt/Kiro" },
    "unreadable must not win when a real version is available",
  );
});

test("detectKiroIdeVersion returns null when no Kiro IDE is installed", () => {
  assert.equal(
    detectKiroIdeVersion({
      platform: "darwin",
      homedir: "/Users/dev",
      env: {},
      readFile: () => null,
    }),
    null,
  );
});

test("parseKiroVersionOutput reads a line that is exactly a version", () => {
  assert.equal(parseKiroVersionOutput("1.0.293\n"), "1.0.293");
  assert.equal(parseKiroVersionOutput("v1.0.293"), "1.0.293");
  assert.equal(parseKiroVersionOutput("  1.0  \n"), "1.0");
});

test("parseKiroVersionOutput anchors on the line start among noise", () => {
  const output = ["Kiro", "1.0.293", "a1b2c3d4", "x64"].join("\n");
  assert.equal(parseKiroVersionOutput(output), "1.0.293");
  assert.equal(
    parseKiroVersionOutput("1.0.293 (a1b2c3d4, x64)\ncommit a1b2c3d4\n"),
    "1.0.293",
    "a version-led line still matches when the line carries a suffix",
  );
});

test("parseKiroVersionOutput ignores embedded versions from the VS Code fork base", () => {
  // A fork's --version prints Electron and VS Code base versions too; a global
  // "any digit triple" scan would happily report Electron's as the IDE's.
  const output = [
    "Kiro IDE built on Code 1.94.2",
    "1.0.293",
    "Electron 32.2.6",
    "Chromium 128.0.6613.186",
  ].join("\n");
  assert.equal(parseKiroVersionOutput(output), "1.0.293");
});

test("parseKiroVersionOutput returns null when nothing looks like a version", () => {
  assert.equal(parseKiroVersionOutput("kiro: command failed\n"), null);
  assert.equal(parseKiroVersionOutput(""), null);
  assert.equal(parseKiroVersionOutput(null), null);
  assert.equal(parseKiroVersionOutput(undefined), null);
});

test("detectKiroIde falls back to `kiro --version` on PATH", () => {
  // The stock-path gap: a custom install location has no readable bundle, but
  // the `kiro` shim on PATH can still answer.
  const calls = [];
  assert.deepEqual(
    detectKiroIde({
      platform: "linux",
      homedir: "/home/dev",
      env: { PATH: "/usr/local/bin" },
      readFile: () => null,
      exists: (candidate) => candidate === "/usr/local/bin/kiro",
      runVersion: (executable) => {
        calls.push(executable);
        return "1.0.293\n";
      },
    }),
    { version: "1.0.293", parsed: [1, 0, 293], source: "path", executable: "/usr/local/bin/kiro" },
  );
  assert.deepEqual(calls, ["/usr/local/bin/kiro"]);
});

test("detectKiroIde prefers the application bundle over the PATH fallback", () => {
  let ran = false;
  assert.deepEqual(
    detectKiroIde({
      platform: "linux",
      homedir: "/home/dev",
      env: { PATH: "/usr/local/bin" },
      readFile: (file) =>
        file === "/opt/Kiro/resources/app/package.json" ? '{"version":"1.0.293"}' : null,
      exists: () => true,
      runVersion: () => {
        ran = true;
        return "9.9.9";
      },
    }),
    { version: "1.0.293", parsed: [1, 0, 293], source: "app", appPath: "/opt/Kiro" },
  );
  assert.equal(ran, false, "no subprocess is spawned when the bundle answers");
});

test("detectKiroIde keeps the unreadable state when the PATH fallback fails too", () => {
  assert.deepEqual(
    detectKiroIde({
      platform: "linux",
      homedir: "/home/dev",
      env: { PATH: "/usr/local/bin" },
      readFile: (file) =>
        file === "/opt/Kiro/resources/app/package.json" ? '{"name":"kiro"}' : null,
      exists: () => true,
      runVersion: () => "kiro: unknown option --version\n",
    }),
    { unreadable: true, appPath: "/opt/Kiro" },
  );
});

test("detectKiroIde returns null when neither the bundle nor PATH knows Kiro", () => {
  assert.equal(
    detectKiroIde({
      platform: "linux",
      homedir: "/home/dev",
      env: { PATH: "/usr/local/bin" },
      readFile: () => null,
      exists: () => false,
      runVersion: () => "1.0.293",
    }),
    null,
  );
});

test("resolvePaths keeps everything under the injected homedir", () => {
  const paths = resolvePaths({ homedir: "/home/dev", cwd: "/work" });
  assert.equal(paths.interceptorTarget, "/home/dev/.denied/kiro/interceptor.js");
  assert.equal(paths.manifestPath, "/home/dev/.denied/kiro/install-manifest.json");
  assert.equal(paths.configPath, "/home/dev/.denied/config.json");
  assert.deepEqual(
    paths.hookFiles.map((hook) => hook.path),
    ["/home/dev/.kiro/hooks/denied.json"],
  );
});

test("resolvePaths adds the workspace hook file and expands ~ and relatives", () => {
  const fromTilde = resolvePaths({ homedir: "/home/dev", cwd: "/work", workspace: "~/proj" });
  assert.equal(fromTilde.hookFiles[1].path, "/home/dev/proj/.kiro/hooks/denied.json");
  const fromRelative = resolvePaths({ homedir: "/home/dev", cwd: "/work", workspace: "sub" });
  assert.equal(fromRelative.hookFiles[1].path, "/work/sub/.kiro/hooks/denied.json");
});

test("findOnPath scans PATH entries in order", () => {
  const env = { PATH: ["/a", "/b"].join(path.delimiter) };
  const found = findOnPath("kiro-cli", env, (candidate) => candidate === "/b/kiro-cli", "linux");
  assert.equal(found, "/b/kiro-cli");
  assert.equal(findOnPath("kiro-cli", env, () => false, "linux"), null);
});

// ---------------------------------------------------------------------------
// Template rendering — R13/N10: absolute paths in every generated command
// ---------------------------------------------------------------------------

test("buildHookEntry renders the v1 entry the two supported surfaces expect", () => {
  const entry = makeEntry();
  assert.equal(entry.name, HOOK_NAME);
  assert.equal(entry.trigger, "PreToolUse");
  assert.equal(entry.matcher, ".*", "matcher must be a regex, not a glob");
  assert.equal(entry.action.type, "command");
  assert.equal(entry.timeout, 20, "host timeout must sit above the interceptor watchdog");
  assert.equal(entry.enabled, true);
  assert.equal(entry.action.command, 'node "/home/dev/.denied/kiro/interceptor.js"');
});

test("buildHookEntry expands ~ to an absolute path in the command", () => {
  const entry = buildHookEntry(TEMPLATE_RAW, "~/.denied/kiro/interceptor.js", "/home/dev");
  assert.equal(entry.action.command, 'node "/home/dev/.denied/kiro/interceptor.js"');
  assert.ok(!entry.action.command.includes("~"));
});

test("buildHookEntry refuses a path that cannot be quoted safely", () => {
  assert.throws(
    () => buildHookEntry(TEMPLATE_RAW, '/home/dev/we"ird/interceptor.js', "/home/dev"),
    /double quote/,
  );
});

// ---------------------------------------------------------------------------
// v1 merge semantics
// ---------------------------------------------------------------------------

test("mergeHookFile creates a fresh v1 file when none exists", () => {
  const merged = mergeHookFile(null, makeEntry());
  assert.equal(merged.ok, true);
  assert.equal(merged.action, "create");
  assert.deepEqual(merged.data.version, "v1");
  assert.equal(merged.data.hooks.length, 1);
  assert.equal(merged.data.hooks[0].name, HOOK_NAME);
});

test("mergeHookFile preserves user-authored hooks when adding ours", () => {
  const existing = serializeHookFile({
    version: "v1",
    hooks: [{ name: "my-linter", trigger: "PostToolUse", matcher: ".*" }],
  });
  const merged = mergeHookFile(existing, makeEntry());
  assert.equal(merged.ok, true);
  assert.equal(merged.action, "add");
  assert.equal(merged.data.hooks.length, 2);
  assert.equal(merged.data.hooks[0].name, "my-linter");
  assert.equal(merged.data.hooks[1].name, HOOK_NAME);
});

test("mergeHookFile replaces an existing denied-authz entry in place", () => {
  const stale = serializeHookFile({
    version: "v1",
    hooks: [
      { name: "my-linter", trigger: "PostToolUse" },
      { name: HOOK_NAME, trigger: "PreToolUse", action: { type: "command", command: "node /old/path.js" } },
      { name: "my-formatter", trigger: "Stop" },
    ],
  });
  const merged = mergeHookFile(stale, makeEntry());
  assert.equal(merged.action, "replace");
  assert.equal(merged.data.hooks.length, 3, "no duplication");
  assert.equal(
    merged.data.hooks.filter((hook) => hook.name === HOOK_NAME).length,
    1,
  );
  assert.equal(merged.data.hooks[1].action.command, 'node "/home/dev/.denied/kiro/interceptor.js"');
  assert.deepEqual(
    merged.data.hooks.map((hook) => hook.name),
    ["my-linter", HOOK_NAME, "my-formatter"],
    "position and neighbours preserved",
  );
});

test("mergeHookFile is idempotent across repeated merges", () => {
  const once = serializeHookFile(mergeHookFile(null, makeEntry()).data);
  const twice = serializeHookFile(mergeHookFile(once, makeEntry()).data);
  assert.equal(once, twice);
});

test("mergeHookFile refuses a malformed file instead of clobbering it", () => {
  const bad = mergeHookFile("{ not json", makeEntry());
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not valid JSON/);

  const wrongShape = mergeHookFile('["a"]', makeEntry());
  assert.equal(wrongShape.ok, false);

  const wrongHooks = mergeHookFile('{"version":"v1","hooks":{}}', makeEntry());
  assert.equal(wrongHooks.ok, false);
  assert.match(wrongHooks.reason, /not an array/);
});

// ---------------------------------------------------------------------------
// Entry removal
// ---------------------------------------------------------------------------

test("removeHookEntry deletes the file only when nothing else is left", () => {
  const onlyOurs = serializeHookFile(mergeHookFile(null, makeEntry()).data);
  assert.deepEqual(removeHookEntry(onlyOurs), { ok: true, action: "delete" });

  const shared = serializeHookFile({
    version: "v1",
    hooks: [{ name: "my-linter" }, makeEntry()],
  });
  const result = removeHookEntry(shared);
  assert.equal(result.action, "remove");
  assert.deepEqual(result.data.hooks.map((hook) => hook.name), ["my-linter"]);

  assert.deepEqual(removeHookEntry(null), { ok: true, action: "absent" });
  assert.deepEqual(removeHookEntry('{"version":"v1","hooks":[]}'), { ok: true, action: "absent" });
  assert.equal(removeHookEntry("{ nope").ok, false);
});

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

test("mergeManifestEntries carries forward files this run no longer manages", () => {
  const previous = [
    { path: "/w/.kiro/hooks/denied.json", kind: "hook", hash: "a", backup: "/w/backup" },
  ];
  const current = [{ path: "/h/.kiro/hooks/denied.json", kind: "hook", hash: "b", backup: null }];
  const merged = mergeManifestEntries(previous, current);
  assert.deepEqual(merged.map((entry) => entry.path).sort(), [
    "/h/.kiro/hooks/denied.json",
    "/w/.kiro/hooks/denied.json",
  ]);
});

test("mergeManifestEntries keeps the earliest backup for a re-managed file", () => {
  const merged = mergeManifestEntries(
    [{ path: "/f", hash: "a", backup: "/f.first" }],
    [{ path: "/f", hash: "b", backup: "/f.second" }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].hash, "b");
  assert.equal(merged[0].backup, "/f.first");
});

test("detectDrift reports modified and missing managed files", () => {
  const manifest = {
    files: [
      { path: "/a", hash: require("node:crypto").createHash("sha256").update("A").digest("hex") },
      { path: "/b", hash: "deadbeef" },
      { path: "/c", hash: "cafe" },
    ],
  };
  const reader = (file) => (file === "/a" ? "A" : file === "/b" ? "changed" : null);
  assert.deepEqual(detectDrift(manifest, reader), [
    { path: "/b", status: "modified" },
    { path: "/c", status: "missing" },
  ]);
  assert.deepEqual(detectDrift(null, reader), []);
});

// ---------------------------------------------------------------------------
// End-to-end install
// ---------------------------------------------------------------------------

test("install stages the interceptor, writes one hook file, and records a manifest", async () => {
  const sandbox = makeSandbox();
  const { code, output } = await runInstaller(sandbox);
  assert.equal(code, 0, output);

  const staged = path.join(sandbox.homedir, ".denied", "kiro", "interceptor.js");
  assert.equal(fs.readFileSync(staged, "utf-8"), INTERCEPTOR_BODY);
  assert.equal(fs.statSync(path.dirname(staged)).mode & 0o777, 0o700);

  const hook = readJson(globalHookPath(sandbox));
  assert.equal(hook.version, "v1");
  assert.equal(hook.hooks[0].name, HOOK_NAME);
  assert.equal(hook.hooks[0].action.command, `node "${staged}"`);
  assert.ok(path.isAbsolute(staged));

  const manifest = readJson(manifestPath(sandbox));
  assert.equal(manifest.version, 1);
  assert.deepEqual(
    manifest.files.map((entry) => entry.path).sort(),
    [globalHookPath(sandbox), staged].sort(),
    "every written file is recorded",
  );
  for (const entry of manifest.files) {
    assert.equal(entry.hash, require("node:crypto").createHash("sha256")
      .update(fs.readFileSync(entry.path, "utf-8"), "utf-8").digest("hex"));
    assert.equal(entry.action, "created");
  }
  assert.match(output, /REQUIRED: Restart Kiro IDE completely/);
  assert.match(output, /empty Agent Hooks panel does not mean the hook is missing/);
});

test("install records a backup when it modifies a pre-existing hook file", async () => {
  const sandbox = makeSandbox();
  const hookPath = globalHookPath(sandbox);
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  const userContent = serializeHookFile({
    version: "v1",
    hooks: [{ name: "my-linter", trigger: "PostToolUse" }],
  });
  fs.writeFileSync(hookPath, userContent);

  const { code, output } = await runInstaller(sandbox);
  assert.equal(code, 0, output);

  const manifest = readJson(manifestPath(sandbox));
  const record = manifest.files.find((entry) => entry.path === hookPath);
  assert.equal(record.action, "modified");
  assert.ok(record.backup, "a modified user file must have a backup recorded");
  assert.equal(fs.readFileSync(record.backup, "utf-8"), userContent);

  const hook = readJson(hookPath);
  assert.deepEqual(hook.hooks.map((entry) => entry.name), ["my-linter", HOOK_NAME]);
});

test("install refuses a malformed hook file and writes nothing at all", async () => {
  const sandbox = makeSandbox();
  const hookPath = globalHookPath(sandbox);
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, "{ definitely not json");

  const { code, output } = await runInstaller(sandbox);
  assert.equal(code, 1);
  assert.match(output, /refusing to install - nothing was written/);
  assert.equal(fs.readFileSync(hookPath, "utf-8"), "{ definitely not json");
  assert.equal(fs.existsSync(path.join(sandbox.homedir, ".denied")), false);
});

test("install is idempotent: a second run changes nothing on disk", async () => {
  const sandbox = makeSandbox();
  await runInstaller(sandbox);
  const before = listFilesRecursively(sandbox.homedir).map((file) => [
    file,
    fs.readFileSync(file, "utf-8"),
  ]);

  const { code, output } = await runInstaller(sandbox, [], { now: Date.UTC(2026, 7, 5) });
  assert.equal(code, 0, output);
  const after = listFilesRecursively(sandbox.homedir).map((file) => [
    file,
    fs.readFileSync(file, "utf-8"),
  ]);
  assert.deepEqual(
    after.filter(([file]) => !file.endsWith("install-manifest.json")),
    before.filter(([file]) => !file.endsWith("install-manifest.json")),
  );
  assert.match(output, /unchanged/);
});

test("install with --workspace registers the workspace hook file too", async () => {
  const sandbox = makeSandbox();
  const workspace = path.join(sandbox.root, "project");
  fs.mkdirSync(workspace, { recursive: true });

  const { code, output } = await runInstaller(sandbox, [`--workspace=${workspace}`]);
  assert.equal(code, 0, output);

  const workspaceHook = path.join(workspace, ".kiro", "hooks", "denied.json");
  assert.equal(readJson(workspaceHook).hooks[0].name, HOOK_NAME);
  const manifest = readJson(manifestPath(sandbox));
  assert.ok(manifest.files.some((entry) => entry.path === workspaceHook));
});

test("install warns loudly when no API key is configured", async () => {
  const sandbox = makeSandbox();
  const { output } = await runInstaller(sandbox);
  assert.match(output, /WARNING: No Denied API key found/);
  assert.match(output, /fails open on every tool call/);
});

// ---------------------------------------------------------------------------
// R19 — the mandatory CLI V2 warning
// ---------------------------------------------------------------------------

test("install warns that Kiro CLI V2 is unenforced when kiro-cli is on PATH", async () => {
  const sandbox = makeSandbox();
  const fakeBin = path.join(sandbox.root, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "kiro-cli"), "#!/bin/sh\n", { mode: 0o755 });

  const { code, output } = await runInstaller(sandbox, [], {
    env: { PATH: [fakeBin, process.env.PATH].join(path.delimiter) },
  });
  assert.equal(code, 0, output);
  assert.match(output, /WARNING: Kiro CLI V2 is not enforced by Denied/);
  assert.match(output, /kiro-cli --v3/);
  for (const claim of FORBIDDEN_CLAIMS) {
    assert.ok(!claim.test(output), `install output must never claim ${claim}`);
  }
});

test("install never claims V2 coverage when kiro-cli is absent either", async () => {
  const sandbox = makeSandbox();
  const emptyBin = path.join(sandbox.root, "empty-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  const { output } = await runInstaller(sandbox, [], {
    env: { PATH: [emptyBin, path.dirname(process.execPath)].join(path.delimiter) },
  });
  assert.ok(!/kiro-cli on PATH: \//.test(output));
  for (const claim of FORBIDDEN_CLAIMS) {
    assert.ok(!claim.test(output));
  }
});

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

test("a re-run reports drift after the user hand-edits a managed file", async () => {
  const sandbox = makeSandbox();
  await runInstaller(sandbox);

  const hookPath = globalHookPath(sandbox);
  const edited = readJson(hookPath);
  edited.hooks[0].timeout = 45;
  fs.writeFileSync(hookPath, serializeHookFile(edited));

  const { code, output } = await runInstaller(sandbox, [], { now: Date.UTC(2026, 7, 6) });
  assert.equal(code, 0, output);
  assert.match(output, /changed since Denied installed it/);
  assert.match(output, /backup is written first/);
  // The explicit re-run still updates the file, but says so.
  assert.equal(readJson(hookPath).hooks[0].timeout, 20);
  const record = readJson(manifestPath(sandbox)).files.find((entry) => entry.path === hookPath);
  assert.ok(record.backup, "the hand-edited version is backed up before being replaced");
});

// ---------------------------------------------------------------------------
// --dry-run
// ---------------------------------------------------------------------------

test("--dry-run prints the plan and writes nothing", async () => {
  const sandbox = makeSandbox();
  const { code, output } = await runInstaller(sandbox, ["--dry-run"]);
  assert.equal(code, 0, output);
  assert.match(output, /Plan:/);
  assert.match(output, /Dry run: nothing was written/);
  assert.deepEqual(listFilesRecursively(sandbox.homedir), []);
});

test("--dry-run --uninstall removes nothing", async () => {
  const sandbox = makeSandbox();
  await runInstaller(sandbox);
  const before = listFilesRecursively(sandbox.homedir);
  const { code, output } = await runInstaller(sandbox, ["--uninstall", "--dry-run"]);
  assert.equal(code, 0, output);
  assert.match(output, /Dry run: nothing was removed/);
  assert.deepEqual(listFilesRecursively(sandbox.homedir), before);
});

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

test("uninstall reverses a fresh install exactly", async () => {
  const sandbox = makeSandbox();
  const configPath = path.join(sandbox.homedir, ".denied", "config.json");
  await runInstaller(sandbox);
  fs.writeFileSync(configPath, '{"apiKey":"dn_keep_me"}\n');

  const { code, output } = await runInstaller(sandbox, ["--uninstall"]);
  assert.equal(code, 0, output);

  assert.equal(fs.existsSync(globalHookPath(sandbox)), false, "our file held only our hook");
  assert.equal(fs.existsSync(path.join(sandbox.homedir, ".denied", "kiro")), false);
  assert.equal(fs.readFileSync(configPath, "utf-8"), '{"apiKey":"dn_keep_me"}\n');
  assert.match(output, /Left untouched/);
});

test("uninstall preserves user hooks in a shared file and untouched siblings", async () => {
  const sandbox = makeSandbox();
  const hooksDir = path.join(sandbox.homedir, ".kiro", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const userContent = serializeHookFile({
    version: "v1",
    hooks: [{ name: "my-linter", trigger: "PostToolUse" }],
  });
  fs.writeFileSync(path.join(hooksDir, "denied.json"), userContent);
  const sibling = path.join(hooksDir, "team.json");
  fs.writeFileSync(sibling, '{"version":"v1","hooks":[]}\n');

  await runInstaller(sandbox);
  const { code } = await runInstaller(sandbox, ["--uninstall"]);
  assert.equal(code, 0);

  const remaining = readJson(path.join(hooksDir, "denied.json"));
  assert.deepEqual(remaining.hooks.map((hook) => hook.name), ["my-linter"]);
  assert.equal(fs.readFileSync(sibling, "utf-8"), '{"version":"v1","hooks":[]}\n');
});

test("uninstall removes legacy denied*.kiro.hook files", async () => {
  const sandbox = makeSandbox();
  const hooksDir = path.join(sandbox.homedir, ".kiro", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const legacy = path.join(hooksDir, "denied-authz.kiro.hook");
  const foreignLegacy = path.join(hooksDir, "team-lint.kiro.hook");
  fs.writeFileSync(legacy, '{"when":{"type":"preToolUse"}}\n');
  fs.writeFileSync(foreignLegacy, "{}\n");

  await runInstaller(sandbox);
  const { code, output } = await runInstaller(sandbox, ["--uninstall"]);
  assert.equal(code, 0, output);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.existsSync(foreignLegacy), true, "only Denied's legacy files are removed");
});

test("uninstall covers the workspace file and nothing outside the recorded set", async () => {
  const sandbox = makeSandbox();
  const workspace = path.join(sandbox.root, "project");
  fs.mkdirSync(workspace, { recursive: true });
  const unrelated = path.join(sandbox.homedir, "keep-me.txt");
  fs.writeFileSync(unrelated, "untouched\n");

  await runInstaller(sandbox, [`--workspace=${workspace}`]);
  const workspaceHook = path.join(workspace, ".kiro", "hooks", "denied.json");
  assert.equal(fs.existsSync(workspaceHook), true);

  const { code } = await runInstaller(sandbox, ["--uninstall", `--workspace=${workspace}`]);
  assert.equal(code, 0);
  assert.equal(fs.existsSync(workspaceHook), false);
  assert.deepEqual(listFilesRecursively(sandbox.homedir), [unrelated]);
});

test("uninstall without --workspace still cleans a workspace file the manifest recorded", async () => {
  const sandbox = makeSandbox();
  const workspace = path.join(sandbox.root, "project");
  fs.mkdirSync(workspace, { recursive: true });
  await runInstaller(sandbox, [`--workspace=${workspace}`]);

  const { code } = await runInstaller(sandbox, ["--uninstall"]);
  assert.equal(code, 0);
  assert.equal(
    fs.existsSync(path.join(workspace, ".kiro", "hooks", "denied.json")),
    false,
    "the manifest is what makes uninstall exact",
  );
});

test("uninstall refuses to clobber an unparseable hook file", async () => {
  const sandbox = makeSandbox();
  await runInstaller(sandbox);
  const hookPath = globalHookPath(sandbox);
  fs.writeFileSync(hookPath, "{ hand-broken");

  const { code, output } = await runInstaller(sandbox, ["--uninstall"]);
  assert.equal(code, 1);
  assert.match(output, /SKIP \(unparseable\)/);
  assert.equal(fs.readFileSync(hookPath, "utf-8"), "{ hand-broken");
});

test("uninstall on a clean machine reports nothing to do", async () => {
  const sandbox = makeSandbox();
  const { code, output } = await runInstaller(sandbox, ["--uninstall"]);
  assert.equal(code, 0);
  assert.match(output, /Nothing to remove/);
  assert.deepEqual(listFilesRecursively(sandbox.homedir), []);
});

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

test("--check passes when the gate is installed and the PDP answers", async () => {
  const sandbox = makeSandbox();
  await runInstaller(sandbox);

  const calls = [];
  const { code, output } = await runInstaller(sandbox, ["--check"], {
    env: { DENIED_API_KEY: "dn_test", DENIED_URL: "https://pdp.example", PATH: process.env.PATH },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { status: 200 };
    },
  });
  assert.equal(code, 0, output);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://pdp.example/pdp/check");
  assert.equal(calls[0].init.headers["X-API-Key"], "dn_test");
  assert.match(output, /\[PASS\] hook file \(global\)/);
  assert.match(output, /\[PASS\] interceptor staged/);
  assert.match(output, /\[PASS\] node on PATH/);
  assert.match(output, /\[PASS\] API key configured/);
  assert.match(output, /\[PASS\] PDP reachable/);
  assert.match(output, /\[PASS\] PDP accepts checks/);
  assert.match(output, /cannot prove a running Kiro IDE has loaded it/);
  assert.ok(!/\[FAIL\]/.test(output), output);
});

test("--check separates transport reachability from a usable PDP response", async () => {
  const sandbox = makeSandbox();
  await runInstaller(sandbox);

  // A 404 proves the transport works, but the interceptor treats any non-2xx as
  // an error and fails open - a wrong URL must not be certified as working.
  const notFound = await runInstaller(sandbox, ["--check"], {
    env: { DENIED_API_KEY: "dn", PATH: process.env.PATH },
    fetch: async () => ({ status: 404 }),
  });
  assert.equal(notFound.code, 1, notFound.output);
  assert.match(notFound.output, /\[PASS\] PDP reachable: .*HTTP 404/);
  assert.match(notFound.output, /\[FAIL\] PDP accepts checks: HTTP 404/);
  assert.match(notFound.output, /is this URL a Denied PDP\?/);
  assert.match(notFound.output, /NOT enforcing/);

  const offline = await runInstaller(sandbox, ["--check"], {
    env: { DENIED_API_KEY: "dn", PATH: process.env.PATH },
    fetch: async () => {
      throw new Error("getaddrinfo ENOTFOUND api.denied.dev");
    },
  });
  assert.equal(offline.code, 1);
  assert.match(offline.output, /\[FAIL\] PDP reachable/);
  assert.match(offline.output, /NOT enforcing/);
  assert.ok(
    !/PDP accepts checks/.test(offline.output),
    "an unreachable PDP is one failure, not two",
  );
});

test("--check fails a hook entry wired to the wrong trigger or matcher", async () => {
  const rewire = async (mutate) => {
    const sandbox = makeSandbox();
    await runInstaller(sandbox);
    const hookPath = globalHookPath(sandbox);
    const hook = readJson(hookPath);
    mutate(hook.hooks[0]);
    fs.writeFileSync(hookPath, serializeHookFile(hook));
    return runInstaller(sandbox, ["--check"], {
      env: { DENIED_API_KEY: "dn_test", PATH: process.env.PATH },
      fetch: async () => ({ status: 200 }),
    });
  };

  const wrongTrigger = await rewire((entry) => {
    entry.trigger = "PostToolUse";
  });
  assert.equal(wrongTrigger.code, 1, wrongTrigger.output);
  assert.match(wrongTrigger.output, /\[FAIL\] hook file \(global\)/);
  assert.match(wrongTrigger.output, /mis-wired and will not gate tool calls/);
  assert.match(wrongTrigger.output, /trigger="PostToolUse" - expected "PreToolUse"/);
  assert.match(wrongTrigger.output, /NOT enforcing/);

  const wrongMatcher = await rewire((entry) => {
    entry.matcher = "execute_bash";
  });
  assert.equal(wrongMatcher.code, 1, wrongMatcher.output);
  assert.match(wrongMatcher.output, /matcher="execute_bash" - expected "\.\*"/);
  assert.match(wrongMatcher.output, /NOT enforcing/);
});

test("--check fails a hook entry whose command does not run the staged interceptor", async () => {
  const sandbox = makeSandbox();
  await runInstaller(sandbox);
  const hookPath = globalHookPath(sandbox);
  const hook = readJson(hookPath);
  hook.hooks[0].action.command = 'node "/somewhere/else/interceptor.js"';
  fs.writeFileSync(hookPath, serializeHookFile(hook));

  const { code, output } = await runInstaller(sandbox, ["--check"], {
    env: { DENIED_API_KEY: "dn_test", PATH: process.env.PATH },
    fetch: async () => ({ status: 200 }),
  });
  assert.equal(code, 1, output);
  assert.match(output, /\[FAIL\] hook file \(global\)/);
  assert.match(output, /command does not reference .*\.denied[/\\]kiro[/\\]interceptor\.js/);
  assert.match(output, /NOT enforcing/);
});

test("--check fails when no API key is configured", async () => {
  const sandbox = makeSandbox();
  await runInstaller(sandbox);

  const { code, output } = await runInstaller(sandbox, ["--check"], {
    env: { PATH: process.env.PATH },
    fetch: async () => ({ status: 200 }),
  });
  assert.equal(code, 1);
  assert.match(output, /\[FAIL\] API key configured/);
  assert.match(output, /DENIED_API_KEY/);
  assert.match(output, /\.denied[/\\]config\.json/);
  assert.match(output, /fails open/);
  assert.match(output, /NOT enforcing/);

  // The PDP will reject the unauthenticated probe; that message must point at
  // the missing key rather than accuse the user of configuring a bad one.
  const rejected = await runInstaller(sandbox, ["--check"], {
    env: { PATH: process.env.PATH },
    fetch: async () => ({ status: 401 }),
  });
  assert.equal(rejected.code, 1);
  assert.match(rejected.output, /rejects unauthenticated checks/);
  assert.ok(!/rejected the configured API key/.test(rejected.output));
});

test("--check fails when the PDP rejects the credentials", async () => {
  const sandbox = makeSandbox();
  await runInstaller(sandbox);

  for (const status of [401, 403]) {
    const { code, output } = await runInstaller(sandbox, ["--check"], {
      env: { DENIED_API_KEY: "dn_bad", PATH: process.env.PATH },
      fetch: async () => ({ status }),
    });
    assert.equal(code, 1, output);
    assert.match(output, /\[PASS\] PDP reachable/);
    assert.match(output, new RegExp(`\\[FAIL\\] PDP accepts checks: HTTP ${status}`));
    assert.match(output, /rejected the configured API key/);
    assert.match(output, /NOT enforcing/);
  }
});

test("--check fails when the PDP returns a server error", async () => {
  const sandbox = makeSandbox();
  await runInstaller(sandbox);

  const { code, output } = await runInstaller(sandbox, ["--check"], {
    env: { DENIED_API_KEY: "dn_test", PATH: process.env.PATH },
    fetch: async () => ({ status: 503 }),
  });
  assert.equal(code, 1, output);
  assert.match(output, /\[PASS\] PDP reachable/);
  assert.match(output, /\[FAIL\] PDP accepts checks: HTTP 503/);
  assert.match(output, /fail-open until it recovers/);
  assert.match(output, /NOT enforcing/);
});

test("--check fails when nothing is installed and reports legacy hook files", async () => {
  const sandbox = makeSandbox();
  const hooksDir = path.join(sandbox.homedir, ".kiro", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "denied.kiro.hook"), "{}\n");

  const { code, output } = await runInstaller(sandbox, ["--check"], {
    fetch: async () => ({ status: 200 }),
  });
  assert.equal(code, 1);
  assert.match(output, /\[FAIL\] hook file \(global\): missing/);
  assert.match(output, /\[FAIL\] interceptor staged: missing/);
  assert.match(output, /legacy \.kiro\.hook files found/);
  assert.match(output, /denied\.kiro\.hook/);
});

test("--check fails a hook entry that is present but disabled", async () => {
  const sandbox = makeSandbox();
  await runInstaller(sandbox);
  const hookPath = globalHookPath(sandbox);
  const hook = readJson(hookPath);
  hook.hooks[0].enabled = false;
  fs.writeFileSync(hookPath, serializeHookFile(hook));

  const { code, output } = await runInstaller(sandbox, ["--check"], {
    fetch: async () => ({ status: 200 }),
  });
  assert.equal(code, 1);
  assert.match(output, /present but disabled/);
});

// ---------------------------------------------------------------------------
// --check: the Kiro IDE version condition
//
// An all-PASS --check on an IDE that silently ignores the hook file is the
// exact failure this condition exists to prevent.
// ---------------------------------------------------------------------------

async function checkWithIde(detectKiroIde) {
  const sandbox = makeSandbox();
  await runInstaller(sandbox);
  return runInstaller(sandbox, ["--check"], {
    detectKiroIde,
    platform: "darwin",
    env: { DENIED_API_KEY: "dn_test", PATH: process.env.PATH },
    fetch: async () => ({ status: 200 }),
  });
}

test("--check fails an IDE that predates the v1 PreToolUse hooks system", async () => {
  const { code, output } = await checkWithIde(fakeIde("0.12.333"));
  assert.equal(code, 1, output);
  assert.match(output, /\[FAIL\] Kiro IDE version: 0\.12\.333 at \/Applications\/Kiro\.app/);
  assert.match(output, /predates the v1 PreToolUse hooks system \(added in Kiro IDE 1\.0\.0\)/);
  assert.match(output, /silently ignored and this gate can never fire/);
  assert.match(output, /kiro\.dev\/downloads/);
  assert.match(output, /NOT enforcing/);
});

test("--check fails an IDE that cannot discover global ~/.kiro/hooks", async () => {
  for (const version of ["1.0.0", "1.0.181"]) {
    const { code, output } = await checkWithIde(fakeIde(version));
    assert.equal(code, 1, output);
    assert.match(output, new RegExp(`\\[FAIL\\] Kiro IDE version: ${version.replace(/\./g, "\\.")}`));
    assert.match(output, /does not discover user-level global ~\/\.kiro\/hooks\//);
    assert.match(output, /kirodotdev\/Kiro#9075, fixed in 1\.0\.182/);
    assert.match(output, /--workspace=<project> for every workspace/);
    assert.match(output, /NOT enforcing/);
  }
});

test("--check passes a 1.0.0-1.0.181 IDE when a workspace hook was verified", async () => {
  // Workspace-scoped hooks do load on these builds - it is the stopgap --check
  // itself recommends - so failing a verified workspace install would make the
  // tool contradict its own advice.
  for (const version of ["1.0.0", "1.0.181"]) {
    const sandbox = makeSandbox();
    const workspace = path.join(sandbox.root, "project");
    fs.mkdirSync(workspace, { recursive: true });
    await runInstaller(sandbox, [`--workspace=${workspace}`]);

    const { code, output } = await runInstaller(sandbox, ["--check", `--workspace=${workspace}`], {
      detectKiroIde: fakeIde(version),
      platform: "darwin",
      env: { DENIED_API_KEY: "dn_test", PATH: process.env.PATH },
      fetch: async () => ({ status: 200 }),
    });
    assert.equal(code, 0, output);
    assert.match(output, /\[PASS\] hook file \(workspace\)/);
    assert.match(output, new RegExp(`\\[PASS\\] Kiro IDE version: ${version.replace(/\./g, "\\.")}`));
    // Neither the condition nor the headline may overstate what a workspace
    // install buys on a build that loads no global hook.
    assert.match(output, /that workspace is enforced and every other one is not/);
    // The summary wraps across log lines, each carrying its own prefix.
    assert.match(output, /every prerequisite is in place - for the[\s\S]{0,40}workspace checked above/);
    assert.match(output, /every other[\s\S]{0,40}workspace stays unenforced/);
    assert.ok(!/\[FAIL\]/.test(output), output);
  }
});

test("--check still fails a 1.0.0-1.0.181 IDE with only the global hook installed", async () => {
  // The workspace carve-out must not leak into a global-only install, which is
  // exactly the setup those builds never load.
  const sandbox = makeSandbox();
  const workspace = path.join(sandbox.root, "project");
  fs.mkdirSync(workspace, { recursive: true });
  await runInstaller(sandbox);

  const { code, output } = await runInstaller(sandbox, ["--check", `--workspace=${workspace}`], {
    detectKiroIde: fakeIde("1.0.181"),
    platform: "darwin",
    env: { DENIED_API_KEY: "dn_test", PATH: process.env.PATH },
    fetch: async () => ({ status: 200 }),
  });
  assert.equal(code, 1, output);
  assert.match(output, /\[FAIL\] hook file \(workspace\): missing/);
  assert.match(output, /\[FAIL\] Kiro IDE version: 1\.0\.181/);
  assert.match(output, /--check --workspace=<project>/);
});

test("--check passes a supported IDE and reports its version", async () => {
  for (const version of ["1.0.182", "1.0.293", "2.1.0"]) {
    const { code, output } = await checkWithIde(fakeIde(version));
    assert.equal(code, 0, output);
    assert.match(output, new RegExp(`\\[PASS\\] Kiro IDE version: ${version.replace(/\./g, "\\.")} at /Applications/Kiro\\.app`));
    assert.ok(!/\[FAIL\]/.test(output), output);
  }
});

test("--check notes rather than fails when no Kiro IDE is installed", async () => {
  // A CLI-V3-only machine legitimately has no IDE on disk; failing there would
  // train users to ignore --check's verdict.
  const { code, output } = await checkWithIde(null);
  assert.equal(code, 0, output);
  assert.ok(!/\[FAIL\] Kiro IDE version/.test(output));
  assert.ok(!/\[PASS\] Kiro IDE version/.test(output));
  assert.match(output, /NOTE: Kiro IDE was not found at the known install locations/);
  assert.match(output, /requires Kiro IDE 1\.0\.182 or newer/);
  assert.match(output, /only uses Kiro CLI V3/);
});

test("--check does not claim every prerequisite when the IDE version is unverified", async () => {
  // Exiting 0 here is correct (a CLI-only machine has no IDE), but the summary
  // must not certify a condition that was never evaluated - an unverified
  // too-old IDE is the exact silent fail-open this command exists to catch.
  for (const ide of [null, { unreadable: true, appPath: "/Applications/Kiro.app" }]) {
    const { code, output } = await checkWithIde(ide);
    assert.equal(code, 0, output);
    assert.match(output, /every prerequisite that could be verified is/);
    assert.match(output, /the Kiro IDE version was not one of them/);
    assert.ok(
      !/every prerequisite is in place/.test(output),
      "the unqualified claim is reserved for a run that actually verified the IDE",
    );
  }
});

test("--check claims every prerequisite only when the IDE version was verified", async () => {
  const { code, output } = await checkWithIde(fakeIde("1.0.293"));
  assert.equal(code, 0, output);
  assert.match(output, /Result: the gate is registered and every prerequisite is in place\./);
  assert.ok(!/could be verified/.test(output), output);
});

test("--check warns without failing when the IDE version cannot be read", async () => {
  const { code, output } = await checkWithIde({
    unreadable: true,
    appPath: "/Applications/Kiro.app",
  });
  assert.equal(code, 0, output);
  assert.ok(!/\[FAIL\]/.test(output), output);
  assert.ok(!/\[PASS\] Kiro IDE version/.test(output));
  assert.match(
    output,
    /\[WARN\] Kiro IDE version: Kiro IDE was found at \/Applications\/Kiro\.app, but its version could not be determined/,
  );
  assert.match(output, /compatibility with this gate was not checked/);
  assert.match(output, /Verify by hand that it is 1\.0\.182 or newer/);
  assert.ok(
    !/NOTE: Kiro IDE was not found/.test(output),
    "a bundle on disk is not the same as no IDE at all",
  );
});

test("--check names the PATH fallback as the source of the version", async () => {
  const { code, output } = await checkWithIde({
    version: "1.0.293",
    parsed: parseKiroVersion("1.0.293"),
    source: "path",
    executable: "/usr/local/bin/kiro",
  });
  assert.equal(code, 0, output);
  assert.match(
    output,
    /\[PASS\] Kiro IDE version: 1\.0\.293 via kiro --version at \/usr\/local\/bin\/kiro/,
  );
});

test("--check wires up the real IDE detection by default", async () => {
  // Exercises the default (uninjected) path against a fake app bundle inside the
  // sandbox, reached by pointing the win32 candidate's env var at it.
  const sandbox = makeSandbox();
  const localAppData = path.join(sandbox.root, "AppData", "Local");
  const appDir = path.join(localAppData, "Programs", "Kiro");
  fs.mkdirSync(path.join(appDir, "resources", "app"), { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "resources", "app", "package.json"),
    '{"name":"kiro","version":"1.0.100"}\n',
  );

  const lines = [];
  const code = await run({
    argv: ["--check"],
    homedir: sandbox.homedir,
    cwd: sandbox.root,
    platform: "win32",
    env: { PATH: process.env.PATH, LOCALAPPDATA: localAppData, DENIED_API_KEY: "dn_test" },
    templatePath: TEMPLATE_PATH,
    selfPath: "/repo/extensions/kiro/install.js",
    fetch: async () => ({ status: 200 }),
    log: (line) => lines.push(line),
  });
  const output = lines.join("\n");
  assert.equal(code, 1, output);
  assert.match(output, /\[FAIL\] Kiro IDE version: 1\.0\.100/);
});

// ---------------------------------------------------------------------------
// Install: the too-old-IDE warning never blocks the install
// ---------------------------------------------------------------------------

test("install warns about an unsupported Kiro IDE but still installs", async () => {
  const sandbox = makeSandbox();
  const { code, output } = await runInstaller(sandbox, [], {
    platform: "darwin",
    detectKiroIde: fakeIde("1.0.100"),
  });
  assert.equal(code, 0, output);
  assert.match(output, /Kiro IDE application: 1\.0\.100 at \/Applications\/Kiro\.app/);
  assert.match(output, /WARNING: this Kiro IDE build cannot load the Denied hook/);
  assert.match(output, /kirodotdev\/Kiro#9075/);
  assert.match(output, /--workspace=<project>/);
  assert.match(output, /Upgrade Kiro IDE to 1\.0\.182 or newer/);
  assert.equal(fs.existsSync(globalHookPath(sandbox)), true, "the install still proceeds");
});

test("install explains the missing hooks feature on a pre-1.0 IDE", async () => {
  const sandbox = makeSandbox();
  const { code, output } = await runInstaller(sandbox, [], {
    platform: "darwin",
    detectKiroIde: fakeIde("0.12.333"),
  });
  assert.equal(code, 0, output);
  assert.match(output, /Builds before 1\.0\.0 have no v1 PreToolUse hooks system at all/);
  assert.ok(!/#9075/.test(output), "the pre-1.0 case is a different failure than #9075");
});

test("install says nothing about the IDE version when the build is supported", async () => {
  const sandbox = makeSandbox();
  const { code, output } = await runInstaller(sandbox, [], {
    platform: "darwin",
    detectKiroIde: fakeIde("1.0.293"),
  });
  assert.equal(code, 0, output);
  assert.match(output, /Kiro IDE application: 1\.0\.293 at \/Applications\/Kiro\.app \(supported\)/);
  assert.ok(!/cannot load the Denied hook/.test(output));
});

test("the install preflight spells out the verdict on an unsupported IDE", async () => {
  const sandbox = makeSandbox();
  const { output } = await runInstaller(sandbox, [], {
    platform: "darwin",
    detectKiroIde: fakeIde("1.0.100"),
  });
  assert.match(
    output,
    /Kiro IDE application: 1\.0\.100 at \/Applications\/Kiro\.app \(unsupported - need >= 1\.0\.182\)/,
  );
});

test("the install preflight names the PATH fallback as the source", async () => {
  const sandbox = makeSandbox();
  const { output } = await runInstaller(sandbox, [], {
    platform: "linux",
    detectKiroIde: {
      version: "1.0.293",
      parsed: parseKiroVersion("1.0.293"),
      source: "path",
      executable: "/usr/local/bin/kiro",
    },
  });
  assert.match(
    output,
    /Kiro IDE application: 1\.0\.293 via kiro --version at \/usr\/local\/bin\/kiro \(supported\)/,
  );
});

test("the install preflight flags a found-but-unreadable IDE distinctly", async () => {
  const sandbox = makeSandbox();
  const { code, output } = await runInstaller(sandbox, [], {
    platform: "darwin",
    detectKiroIde: { unreadable: true, appPath: "/Applications/Kiro.app" },
  });
  assert.equal(code, 0, output);
  assert.match(
    output,
    /Kiro IDE application: found at \/Applications\/Kiro\.app, but its version could not be determined \(verify by hand that it is >= 1\.0\.182\)/,
  );
  assert.ok(
    !/cannot load the Denied hook/.test(output),
    "an unknown version is not evidence of an unsupported build",
  );
  assert.ok(!/not found/.test(output));
});

// ---------------------------------------------------------------------------
// Misc CLI behaviour
// ---------------------------------------------------------------------------

test("unknown arguments are rejected with usage", async () => {
  const sandbox = makeSandbox();
  const { code, output } = await runInstaller(sandbox, ["--surface=ide"]);
  assert.equal(code, 1);
  assert.match(output, /Unknown argument/);
  assert.match(output, /Usage: node install\.js/);
  assert.deepEqual(listFilesRecursively(sandbox.homedir), []);
});

test("a missing interceptor source blocks the install without writing", async () => {
  const sandbox = makeSandbox();
  const { code, output } = await runInstaller(sandbox, [], {
    interceptorSource: path.join(sandbox.source, "hooks", "nope.js"),
  });
  assert.equal(code, 1);
  assert.match(output, /Interceptor not found/);
  assert.deepEqual(listFilesRecursively(sandbox.homedir), []);
});
