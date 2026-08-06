#!/usr/bin/env bash
# Denied SDK — installer for the Antigravity (`agy`) PreToolUse authorization hook.
#
# Stages the zero-dependency interceptor into ~/.denied/antigravity/ and merges a
# "denied-authz" group into the target hooks.json files. It never clobbers other
# hook groups, and never writes a `command` it could not verify is runnable — on
# agy <= 1.1.7 an unrunnable hook denies every tool call, and on 1.1.10 it
# silently enforces nothing.
#
# The registered `command` is a shell string: the host re-splits and interprets
# it, so every path baked into it is single-quote escaped here. Workspace scope
# does write machine-specific absolute paths into <workspace>/.agents/hooks.json;
# if that workspace is a git work tree the installer says so loudly, because a
# committed hooks.json breaks on every other machine in exactly the way above.
set -euo pipefail

HOOK_GROUP="denied-authz"
# Host-enforced hook timeout, in SECONDS. Must stay strictly above the
# interceptor's own watchdog (WATCHDOG_MS) so our fail-safe decision always wins
# the race against the host's version-unstable timeout handling. Asserted below
# against the interceptor's exported constant — do not raise the watchdog past
# this without raising this first.
HOOK_TIMEOUT_SECONDS=10

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_INTERCEPTOR="$SCRIPT_DIR/hooks/interceptor.js"

DENIED_HOME="$HOME/.denied"
STAGE_DIR="$DENIED_HOME/antigravity"
STAGE_INTERCEPTOR="$STAGE_DIR/interceptor.js"
# Records every hooks.json this installer has registered, so the uninstaller can
# tell whether some *other* scope still points at the shared staged interceptor
# before deleting it. Installs made before this file existed still work: the
# uninstaller falls back to scanning the well-known scopes.
MANIFEST_FILE="$STAGE_DIR/install-manifest.json"
CONFIG_FILE="$DENIED_HOME/config.json"
GLOBAL_HOOKS="$HOME/.gemini/config/hooks.json"
AGY_NODE_SHIM="$HOME/Library/Application Support/Antigravity/bin/agy-node"

SCOPE="global"
WORKSPACE=""
NODE_OVERRIDE=""
DRY_RUN="false"
FORCE_JSON_REWRITE="false"
NODE_BIN=""
HOOK_COMMAND=""
HAS_API_KEY="no"

log() {
  printf '[denied] %s\n' "$*"
}

warn() {
  printf '[denied] warning: %s\n' "$*" >&2
}

die() {
  printf '[denied] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: extensions/antigravity/install.sh [options]

Installs the Denied PreToolUse authorization hook for Google Antigravity.

Options:
  --scope SCOPE          Where to register the hook: global | workspace | both.
                         Defaults to global (~/.gemini/config/hooks.json).
  --workspace PATH       Workspace root for workspace scope. Defaults to $PWD.
                         Registers in <workspace>/.agents/hooks.json.
  --node PATH            Absolute path to the Node.js 18+ interpreter to bake
                         into the hook command. Defaults to auto-detection.
  --force-json-rewrite   Proceed even when re-serializing an existing hooks.json
                         would change values belonging to other hook groups
                         (huge or non-finite numbers). Off by default: the
                         installer refuses rather than silently damaging them.
  --dry-run              Print the exact files and JSON that would be written
                         and exit without touching anything.
  -h, --help             Show this help.

Files written:
  ~/.denied/antigravity/interceptor.js           staged interceptor (never the checkout)
  ~/.denied/antigravity/install-manifest.json    what was registered where
  ~/.gemini/config/hooks.json                    global scope
  <workspace>/.agents/hooks.json                 workspace scope

Configuration is read at runtime from ~/.denied/config.json (override the path
with DENIED_CONFIG). Environment variables (DENIED_API_KEY, DENIED_URL,
DENIED_FAIL_MODE, DENIED_TIMEOUT_MS) win when present, but only reach hooks of a
CLI session launched from a shell that exported them.
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --scope)
        [ "$#" -ge 2 ] || die "--scope requires a value (global|workspace|both)"
        SCOPE="$2"
        shift 2
        ;;
      --scope=*)
        SCOPE="${1#--scope=}"
        shift
        ;;
      --workspace)
        [ "$#" -ge 2 ] || die "--workspace requires a path"
        WORKSPACE="$2"
        shift 2
        ;;
      --workspace=*)
        WORKSPACE="${1#--workspace=}"
        shift
        ;;
      --node)
        [ "$#" -ge 2 ] || die "--node requires a path"
        NODE_OVERRIDE="$2"
        shift 2
        ;;
      --node=*)
        NODE_OVERRIDE="${1#--node=}"
        shift
        ;;
      --force-json-rewrite)
        FORCE_JSON_REWRITE="true"
        shift
        ;;
      --dry-run)
        DRY_RUN="true"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown option: $1 (run with --help)"
        ;;
    esac
  done

  case "$SCOPE" in
    global|workspace|both) ;;
    *) die "--scope must be one of: global, workspace, both (got '$SCOPE')" ;;
  esac
}

# ---------------------------------------------------------------------------
# Shell quoting
# ---------------------------------------------------------------------------

# The hook `command` is one string that the HOST hands to a shell, so it is shell
# source, not an argv. Every path embedded in it is wrapped in single quotes with
# the '\'' idiom, which neutralises every metacharacter there is — spaces (the
# macOS agy-node shim path contains one by construction), $(...), backticks, ;,
# quotes, tabs. Without this the one fallback that exists for users with no Node
# on PATH would write a 100%-unrunnable registration.
shell_quote() {
  local s=${1-} sq="'" rep
  rep="'\\''"
  printf "'%s'" "${s//$sq/$rep}"
}

# ---------------------------------------------------------------------------
# Platform
# ---------------------------------------------------------------------------

check_platform() {
  local kernel
  kernel="$(uname -s 2>/dev/null || true)"
  case "$kernel" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      die "Antigravity hook execution is broken on Windows (upstream antigravity-cli#222): registered hooks either never fire or fail the tool call outright, so installing here would give you an authorization gate that does not authorize. Not installing. Use macOS or Linux, or run Antigravity itself inside WSL."
      ;;
    Darwin|Linux) ;;
    *)
      die "unsupported platform '$kernel'. This installer supports macOS and Linux."
      ;;
  esac

  if [ "$kernel" = "Linux" ] && grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
    warn "WSL detected. This install gates the Linux-side 'agy' you launch from WSL. A Windows-side Antigravity install reads a different hooks.json and is affected by the broken-on-Windows hook execution (upstream #222) — it will NOT be enforced by this."
  fi
}

# ---------------------------------------------------------------------------
# Node resolution (plan §5.8)
# ---------------------------------------------------------------------------

# Prints the major version of the Node runtime behind $1, or fails. The output
# is checked for being a bare version string: a non-Node binary happily echoes
# the script back, and "Node -e process" must not be mistaken for a version.
node_major() {
  local bin="$1" version major
  version="$("$bin" -e 'process.stdout.write(String(process.versions.node || ""))' </dev/null 2>/dev/null)" || return 1
  case "$version" in
    ''|*[!0-9.]*) return 1 ;;
  esac
  major="${version%%.*}"
  case "$major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$major"
}

node_is_supported() {
  local bin="$1" major
  major="$(node_major "$bin")" || return 1
  [ "$major" -ge 18 ] 2>/dev/null || return 1
  return 0
}

# Absolutises an interpreter path without resolving the final component (a
# version-manager shim is usually a symlink whose target moves; the shim path is
# the stable one). Directory components are resolved with `pwd -P`.
canonical_bin() {
  local candidate="$1" dir base
  dir="$(cd "$(dirname "$candidate")" 2>/dev/null && pwd -P)" || return 1
  base="$(basename "$candidate")"
  case "$dir" in
    /) printf '/%s\n' "$base" ;;
    *) printf '%s/%s\n' "$dir" "$base" ;;
  esac
}

# A relative interpreter makes the hook depend on the hook runtime's PATH, which
# GUI-launched surfaces minimise — so a non-absolute path is refused outright
# rather than written and hoped for.
set_node_bin() {
  local candidate="$1" source="$2" resolved
  resolved="$(canonical_bin "$candidate")" ||
    die "could not resolve '$candidate' ($source) to an absolute path"
  case "$resolved" in
    /*) ;;
    *) die "refusing to register a non-absolute interpreter path '$resolved' ($source): the hook would depend on whatever PATH the host happens to hand it. Pass --node /absolute/path/to/node." ;;
  esac
  [ -x "$resolved" ] ||
    die "refusing to register '$resolved' ($source): it is not an executable file"
  NODE_BIN="$resolved"
}

resolve_node() {
  local candidate major

  if [ -n "$NODE_OVERRIDE" ]; then
    candidate="$NODE_OVERRIDE"
    [ -x "$candidate" ] || die "--node '$candidate' is not an executable file"
    major="$(node_major "$candidate")" ||
      die "--node '$candidate' did not report a Node.js version; it does not look like a Node interpreter"
    [ "$major" -ge 18 ] ||
      die "--node '$candidate' is Node $major; the interceptor requires Node 18+ (native fetch)"
    set_node_bin "$candidate" "from --node"
    log "Node interpreter: $NODE_BIN (from --node)"
    return 0
  fi

  # `command -v node` returns a bare name when node is a shell function, and a
  # relative path when PATH holds one; `type -P` restricts the search to real
  # files on PATH. Whichever answers, the result is absolutised below.
  candidate=""
  if ! candidate="$(type -P node 2>/dev/null)" || [ -z "$candidate" ]; then
    candidate="$(command -v node 2>/dev/null || true)"
  fi
  if [ -n "$candidate" ] && [ -x "$candidate" ] && node_is_supported "$candidate"; then
    set_node_bin "$candidate" "from PATH"
    log "Node interpreter: $NODE_BIN (from PATH, v$(node_major "$NODE_BIN"))"
    return 0
  fi

  # macOS: the Electron-as-Node shim the IDE itself ships. Its path contains a
  # space by construction — see shell_quote().
  if [ -x "$AGY_NODE_SHIM" ] && node_is_supported "$AGY_NODE_SHIM"; then
    set_node_bin "$AGY_NODE_SHIM" "Antigravity's bundled shim"
    log "Node interpreter: $NODE_BIN (Antigravity's bundled shim)"
    return 0
  fi

  local looked_at="${candidate:-(no 'node' on PATH)}"
  die "no usable Node.js 18+ interpreter found.
  Looked at: $looked_at, $AGY_NODE_SHIM
  Refusing to install rather than writing a hook command that cannot run: an
  unrunnable hook denies every tool call on agy <= 1.1.7 and silently enforces
  nothing on 1.1.10 — one bricks your agent, the other looks exactly like a
  working install while allowing everything.
  Install Node 18+ (https://nodejs.org) or pass --node /absolute/path/to/node."
}

# ---------------------------------------------------------------------------
# Timeout budget invariant (plan §5.5)
# ---------------------------------------------------------------------------

# The hook timeout is host-enforced and fixed at 10s here; the interceptor's
# watchdog is the source of truth for the inner deadline. Asserted rather than
# assumed so a future bump to WATCHDOG_MS cannot silently invert the ordering
# and hand the decision back to the host.
assert_timeout_budget() {
  local watchdog_ms hook_ms
  watchdog_ms="$("$NODE_BIN" -e 'const m = require(process.argv[1]); process.stdout.write(String(m.WATCHDOG_MS))' "$SRC_INTERCEPTOR" 2>/dev/null || true)"
  case "$watchdog_ms" in
    ''|*[!0-9]*)
      die "could not read WATCHDOG_MS from $SRC_INTERCEPTOR; refusing to write a hook whose timeout budget cannot be verified"
      ;;
  esac
  hook_ms=$((HOOK_TIMEOUT_SECONDS * 1000))
  [ "$hook_ms" -gt "$watchdog_ms" ] ||
    die "timeout budget violated: hook timeout ${HOOK_TIMEOUT_SECONDS}s (${hook_ms}ms) must be strictly greater than the interceptor watchdog ${watchdog_ms}ms, or the host decides the outcome instead of the fail-safe"
  log "Timeout budget OK: hook ${HOOK_TIMEOUT_SECONDS}s > watchdog ${watchdog_ms}ms"
}

# ---------------------------------------------------------------------------
# hooks.json merge (via Node — JSON is not a shell data type)
# ---------------------------------------------------------------------------

# Exit codes: 3 = target is not usable hooks.json, 4 = filesystem error,
# 5 = refusing a lossy re-serialization. Diagnostics go to stderr already
# prefixed, so the shell never has to guess which of those happened.
# shellcheck disable=SC2016  # single quotes are deliberate: ${...} below are JS
# template literals, and the shell must not expand them.
MERGE_JS='
const fs = require("node:fs");
const path = require("node:path");
const [target, group, command, timeoutRaw, mode, force] = process.argv.slice(1);

// mode is "write" (do it), "print" (dry run) or "validate" (pre-flight parse of
// every target before anything is written). The pre-flight and the real write
// see the same file, so each diagnostic is emitted by exactly one of them:
// file-level notes come from the run that acts, risk notes from the run that
// could refuse.
const note = (msg) => {
  if (mode !== "validate") process.stderr.write(`[denied] ${msg}\n`);
};
const riskNote = (msg) => {
  if (mode !== "write") process.stderr.write(`[denied] ${msg}\n`);
};
const fail = (code, msg) => {
  process.stderr.write(`[denied] error: ${msg}\n`);
  process.exit(code);
};

// A parse-and-reserialize round-trip is not byte preservation. These are the
// cases where it would change a NEIGHBOURING group rather than reformat it.
function rewriteRisks(raw, parsed, skipKey) {
  const destructive = [];
  const cosmetic = [];
  if (!raw || raw.trim() === "") return { destructive, cosmetic };
  let stripped = "";
  let inStr = false;
  let esc = false;
  for (const ch of raw) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") { inStr = true; continue; }
    stripped += ch;
  }
  for (const lit of stripped.match(/-?\d[\d.eE+-]*/g) || []) {
    const n = Number(lit);
    if (!Number.isFinite(n)) {
      destructive.push(`the number ${lit} would be rewritten as null`);
    } else if (/^-?\d+$/.test(lit) && !Number.isSafeInteger(n) && JSON.stringify(n) !== lit) {
      destructive.push(`the integer ${lit} would be rewritten as ${JSON.stringify(n)} (precision lost)`);
    } else if (JSON.stringify(n) !== lit) {
      cosmetic.push(`${lit} will be written as ${JSON.stringify(n)} (same value)`);
    }
  }
  const seen = new Set();
  const isIndexLike = (k) => /^(0|[1-9][0-9]*)$/.test(k);
  const walk = (v) => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const keys = Object.keys(v);
    const idx = keys.filter(isIndexLike);
    if (idx.length > 0) {
      cosmetic.push(`integer-like keys (${idx.join(", ")}) will be emitted before the others`);
    }
    keys.forEach((k) => walk(v[k]));
  };
  for (const k of Object.keys(parsed || {})) {
    if (k !== skipKey) walk(parsed[k]);
  }
  return { destructive, cosmetic };
}

// A hooks.json symlinked into a dotfiles repo is the user deliberately owning
// this file. Replacing the link with a regular file would silently kill their
// edit path, so the write goes THROUGH the link to its target and the link is
// left exactly as it was.
let realTarget = target;
try {
  const st = fs.lstatSync(target);
  if (st.isSymbolicLink()) {
    let resolved;
    try {
      resolved = fs.realpathSync(target);
    } catch {
      resolved = path.resolve(path.dirname(target), fs.readlinkSync(target));
    }
    realTarget = resolved;
    note(`${target} is a symlink -> ${realTarget}; writing through it (the symlink itself is left in place).`);
  }
} catch {
  /* target absent — nothing to lstat */
}

const entry = {
  PreToolUse: [
    {
      matcher: "*",
      hooks: [{ type: "command", command, timeout: Number(timeoutRaw) }],
    },
  ],
};
let existing = {};
let existed = false;
let raw = "";
if (fs.existsSync(realTarget)) {
  existed = true;
  try {
    raw = fs.readFileSync(realTarget, "utf-8");
  } catch (err) {
    fail(4, `cannot read ${realTarget}: ${err.message}`);
  }
  if (raw.trim() !== "") {
    try {
      existing = JSON.parse(raw);
    } catch (err) {
      fail(3, `${realTarget} is not valid JSON: ${err.message}`);
    }
    if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
      fail(3, `${realTarget} is not a JSON object; hooks.json must be a map of named hook groups`);
    }
  }
}

const risks = rewriteRisks(raw, existing, group);
for (const c of risks.cosmetic) riskNote(`reformat note for ${realTarget}: ${c}`);
if (risks.destructive.length > 0) {
  for (const d of risks.destructive) riskNote(`LOSSY rewrite of ${realTarget}: ${d}`);
  if (force !== "force") {
    fail(5, `refusing to rewrite ${realTarget}: writing it back would change values that belong to other hook groups (listed above). Edit or move those groups by hand, or re-run with --force-json-rewrite to accept the change.`);
  }
  riskNote("--force-json-rewrite given: proceeding despite the lossy rewrite above.");
}

const had = Object.prototype.hasOwnProperty.call(existing, group);
const merged = { ...existing, [group]: entry };
const text = JSON.stringify(merged, null, 2) + "\n";
const status = existed ? (had ? "replaced" : "merged") : "created";
if (mode !== "write") {
  process.stdout.write(status + "\n" + text);
  process.exit(0);
}

const dir = path.dirname(realTarget);
const dirExisted = fs.existsSync(dir);
try {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (!dirExisted) fs.chmodSync(dir, 0o755);
} catch (err) {
  fail(4, `cannot create ${dir}: ${err.message}`);
}

// writeFileSync + rename would otherwise reset the file to 0666 & ~umask, so a
// 0600 hooks.json silently becomes world-readable and, under umask 000,
// world-WRITABLE — i.e. anyone on the box could rewrite the command the agent
// runs. The original mode is carried across the rename; a brand-new file gets
// an explicit 0644 rather than whatever the umask says.
let targetMode = null;
if (existed) {
  try {
    targetMode = fs.statSync(realTarget).mode & 0o7777;
  } catch {
    targetMode = null;
  }
}
if (existed && !fs.existsSync(realTarget + ".bak")) {
  try {
    fs.copyFileSync(realTarget, realTarget + ".bak");
    if (targetMode !== null) fs.chmodSync(realTarget + ".bak", targetMode);
    note(`Backed up ${realTarget} -> ${realTarget}.bak`);
  } catch (err) {
    fail(4, `could not write the backup ${realTarget}.bak: ${err.message}`);
  }
}
const finalMode = targetMode === null ? 0o644 : targetMode;
const tmp = `${realTarget}.denied.${process.pid}.tmp`;
try {
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, finalMode);
  fs.renameSync(tmp, realTarget);
} catch (err) {
  try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  fail(4, `could not write ${realTarget}: ${err.message}`);
}
if (finalMode & 0o022) {
  note(`warning: ${realTarget} is group/world-writable (mode ${finalMode.toString(8)}), and it names the command your agent executes. That mode predates this install and was preserved; \`chmod 600\` it unless it is deliberate.`);
}
process.stdout.write(status + "\n");
'

# node_json <script> [args...] — runs a JS snippet, returns its exit code.
merge_force_arg() {
  if [ "$FORCE_JSON_REWRITE" = "true" ]; then
    printf 'force'
  else
    printf 'no'
  fi
}

merge_failed() {
  local target="$1" rc="$2"
  case "$rc" in
    3)
      die "refusing to touch $target — it is not usable hooks.json (see the parse error above). Fix or move the file, then re-run; guessing at its intended contents could silently drop your other hooks."
      ;;
    4)
      die "could not write $target (see the filesystem error above). Check permissions, ownership and free space, then re-run."
      ;;
    5)
      die "refusing to rewrite $target (see the LOSSY rewrite lines above)."
      ;;
    *)
      die "failed while updating $target (node exited $rc; see the error above)."
      ;;
  esac
}

# merge_hooks <target> <mode:write|print>
merge_hooks() {
  local target="$1" mode="$2" out status rc=0
  out="$("$NODE_BIN" -e "$MERGE_JS" "$target" "$HOOK_GROUP" "$HOOK_COMMAND" "$HOOK_TIMEOUT_SECONDS" "$mode" "$(merge_force_arg)")" || rc=$?
  [ "$rc" -eq 0 ] || merge_failed "$target" "$rc"
  status="$(printf '%s\n' "$out" | head -n 1)"
  if [ "$mode" = "print" ]; then
    log "would write $target ($status):"
    printf '%s\n' "$out" | tail -n +2
  else
    case "$status" in
      created) log "Created $target" ;;
      merged) log "Merged '$HOOK_GROUP' into $target (existing groups preserved)" ;;
      replaced) log "Replaced the existing '$HOOK_GROUP' group in $target (other groups preserved)" ;;
      *) log "Wrote $target" ;;
    esac
  fi
}

# Pre-flight: parse every target before anything is written, so a corrupt
# hooks.json aborts the install cleanly instead of half-way through it.
validate_hooks() {
  local target="$1" rc=0
  "$NODE_BIN" -e "$MERGE_JS" "$target" "$HOOK_GROUP" "x" "$HOOK_TIMEOUT_SECONDS" "validate" "$(merge_force_arg)" >/dev/null || rc=$?
  [ "$rc" -eq 0 ] || merge_failed "$target" "$rc"
}

# ---------------------------------------------------------------------------
# Install manifest
# ---------------------------------------------------------------------------

# shellcheck disable=SC2016  # JS source, not a shell expansion
MANIFEST_JS='
const fs = require("node:fs");
const path = require("node:path");
const [file, group, interceptor, command, ...targets] = process.argv.slice(1);
let manifest = { version: 1, hookGroup: group, targets: [] };
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    manifest = { ...manifest, ...parsed };
    if (!Array.isArray(manifest.targets)) manifest.targets = [];
  }
} catch {
  /* absent or unreadable: start a fresh manifest rather than failing an install */
}
manifest.version = 1;
manifest.hookGroup = group;
manifest.interceptor = interceptor;
manifest.command = command;
manifest.updatedAt = new Date().toISOString();
manifest.targets = Array.from(new Set([...manifest.targets.filter((t) => typeof t === "string"), ...targets]));
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const tmp = `${file}.denied.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(tmp, file);
'

# record_manifest <target>...
record_manifest() {
  if [ "$#" -eq 0 ]; then
    return 0
  fi
  if "$NODE_BIN" -e "$MANIFEST_JS" "$MANIFEST_FILE" "$HOOK_GROUP" "$STAGE_INTERCEPTOR" "$HOOK_COMMAND" "$@" 2>/dev/null; then
    log "Recorded the registration in $MANIFEST_FILE"
  else
    warn "could not update $MANIFEST_FILE. The install is fine, but uninstall.sh will fall back to scanning the well-known scopes instead of reading this list."
  fi
}

# ---------------------------------------------------------------------------
# Workspace scope in a git checkout (C8)
# ---------------------------------------------------------------------------

# Workspace scope writes THIS machine's absolute paths. Committed and cloned,
# those paths do not exist elsewhere, and an unrunnable hook command is the one
# failure mode this whole script exists to avoid — silently allowing everything
# on agy 1.1.10, denying everything on <= 1.1.7.
warn_git_workspace() {
  local workspace_root="$1" hooks_path="$2"
  command -v git >/dev/null 2>&1 || return 0
  git -C "$workspace_root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0

  warn "$workspace_root is inside a git work tree."
  warn "  Workspace scope writes $hooks_path with absolute paths that exist only on THIS machine:"
  warn "    $HOOK_COMMAND"
  warn "  If that file is committed and cloned elsewhere, the hook command cannot run there — which silently enforces nothing on agy 1.1.10 and denies every tool call on agy <= 1.1.7."
  if git -C "$workspace_root" check-ignore -q "$hooks_path" 2>/dev/null; then
    warn "  It is git-ignored here, so it will not be committed by accident. Good."
  else
    warn "  It is NOT git-ignored. Either add this to .gitignore:"
    warn "      .agents/hooks.json"
    warn "  or use --scope global (the default), which writes ~/.gemini/config/hooks.json and is read by every surface anyway."
  fi
}

# ---------------------------------------------------------------------------
# Config warning
# ---------------------------------------------------------------------------

warn_missing_api_key() {
  HAS_API_KEY="no"
  if [ -f "$CONFIG_FILE" ]; then
    if "$NODE_BIN" -e '
      const fs = require("node:fs");
      try {
        const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
        process.exit(cfg && typeof cfg.apiKey === "string" && cfg.apiKey.trim() ? 0 : 1);
      } catch {
        process.exit(1);
      }
    ' "$CONFIG_FILE" 2>/dev/null; then
      HAS_API_KEY="yes"
    fi
  fi

  if [ "$HAS_API_KEY" = "yes" ]; then
    log "Found an apiKey in $CONFIG_FILE"
    return 0
  fi

  warn "no apiKey found in $CONFIG_FILE."
  warn "Without one, every tool call resolves through failMode (default 'open' — i.e. the gate allows everything)."
  warn "DENIED_API_KEY works, but only for CLI sessions launched from a shell that exported it; IDE and app surfaces never see it."
  warn "The durable mechanism is the config file. Create it with:"
  printf '  mkdir -p %q && cat > %q <<JSON\n  {\n    "apiKey": "dnd_...",\n    "url": "https://api.denied.dev",\n    "failMode": "open"\n  }\n  JSON\n' "$DENIED_HOME" "$CONFIG_FILE" >&2
}

# ---------------------------------------------------------------------------
# Post-install self-check
# ---------------------------------------------------------------------------

# Reads the command string back out of a hooks.json exactly where the host looks
# for it. A self-check that runs the installer's own idea of the command cannot,
# by construction, catch a registration that was written wrong.
# shellcheck disable=SC2016  # JS source, not a shell expansion
READBACK_JS='
const fs = require("node:fs");
const [target, group] = process.argv.slice(1);
const bail = (msg) => { process.stderr.write(`[denied] error: ${msg}\n`); process.exit(1); };
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(target, "utf-8"));
} catch (err) {
  bail(`cannot read back ${target}: ${err.message}`);
}
const g = parsed && parsed[group];
const entry = g && Array.isArray(g.PreToolUse) ? g.PreToolUse[0] : null;
const hook = entry && Array.isArray(entry.hooks) ? entry.hooks[0] : null;
if (!hook || typeof hook.command !== "string" || hook.command.trim() === "") {
  bail(`${target} has no usable ${group}.PreToolUse[0].hooks[0].command`);
}
if (entry.matcher !== "*") {
  process.stderr.write(`[denied] warning: ${target} registers matcher ${JSON.stringify(entry.matcher)}, expected "*"\n`);
}
process.stdout.write(hook.command);
'

# shellcheck disable=SC2016  # JS source, not a shell expansion
DECISION_JS='
const fs = require("node:fs");
const raw = fs.readFileSync(process.argv[1], "utf-8");
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  process.stdout.write(`stdout was not JSON (${err.message}); it printed: ${JSON.stringify(raw.slice(0, 200))}`);
  process.exit(1);
}
if (!parsed || typeof parsed.decision !== "string" || !parsed.decision) {
  process.stdout.write(`stdout carried no "decision" field: ${JSON.stringify(raw.slice(0, 200))}`);
  process.exit(1);
}
process.stdout.write(parsed.decision);
'

SELF_CHECK_DECISION=""

# self_check_target <hooks.json path>
self_check_target() {
  local target="$1"
  local payload='{"toolCall":{"name":"denied-install-check","args":{}},"conversationId":"denied-install-check"}'
  local tmp_dir stdout_file stderr_file cmd status=0 decision

  if ! cmd="$("$NODE_BIN" -e "$READBACK_JS" "$target" "$HOOK_GROUP")"; then
    warn "self-check FAILED: could not read the registered command back out of $target (see above)."
    return 1
  fi

  log "Self-check: running the command exactly as registered in $target"
  log "  $cmd"

  tmp_dir="$(mktemp -d)"
  stdout_file="$tmp_dir/stdout"
  stderr_file="$tmp_dir/stderr"

  # `sh -c` because the host hands this string to a shell, not to execve — that
  # is precisely where an unquoted space or $(...) in the path shows up. `cd /`
  # so the installer's own cwd cannot make a bad path look good.
  printf '%s' "$payload" | ( cd / && sh -c "$cmd" ) >"$stdout_file" 2>"$stderr_file" || status=$?

  if [ "$status" -ne 0 ]; then
    warn "self-check FAILED: the registered command exited $status (it must always exit 0)."
    if [ "$status" -eq 127 ]; then
      warn "127 means the shell could not find the interpreter — the command string is mis-split or the path is wrong."
    fi
    warn "Its stderr:"
    sed 's/^/  /' "$stderr_file" >&2 || true
    warn "The hook is installed and left in place, but it is NOT working. Fix it before relying on it."
    rm -rf "$tmp_dir"
    return 1
  fi

  if ! decision="$("$NODE_BIN" -e "$DECISION_JS" "$stdout_file" 2>/dev/null)"; then
    warn "self-check FAILED: the registered command did not print a decision object on stdout."
    warn "  $decision"
    warn "Its stderr:"
    sed 's/^/  /' "$stderr_file" >&2 || true
    warn "The hook is installed and left in place, but it is NOT working. Fix it before relying on it."
    rm -rf "$tmp_dir"
    return 1
  fi

  SELF_CHECK_DECISION="$decision"
  log "Self-check OK for $target: the registered command ran (exit 0) and returned decision = $decision"
  if [ -s "$stderr_file" ]; then
    log "Interceptor diagnostics (stderr):"
    sed 's/^/  /' "$stderr_file"
  fi
  rm -rf "$tmp_dir"
  return 0
}

# Says exactly what the self-check did and did not prove. "Self-check passed"
# on its own reads as "the gate works", which is false when the PDP was never
# reached: with no API key the decision below is the fail-open default.
report_self_check_scope() {
  log "What that proves: the hook is registered where the host reads it, the command string survives the host's shell, and the interceptor emits a well-formed decision."
  log "What it does NOT prove: that a policy was evaluated."
  if [ "$HAS_API_KEY" != "yes" ] || [ "$SELF_CHECK_DECISION" = "allow" ]; then
    if [ "$HAS_API_KEY" != "yes" ]; then
      log "  No apiKey is configured, so this run never reached the PDP: decision '$SELF_CHECK_DECISION' is your failMode default, not an authorization decision."
    else
      log "  A decision of 'allow' can equally mean 'policy allowed it' or 'the PDP was unreachable and failMode is open' — check the stderr above and your decision log at https://app.denied.dev."
    fi
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  parse_args "$@"
  check_platform

  [ -f "$SRC_INTERCEPTOR" ] || die "interceptor not found at $SRC_INTERCEPTOR"

  local workspace_hooks="" workspace_root=""
  if [ "$SCOPE" = "workspace" ] || [ "$SCOPE" = "both" ]; then
    workspace_root="${WORKSPACE:-$PWD}"
    [ -d "$workspace_root" ] || die "workspace '$workspace_root' is not a directory"
    workspace_root="$(cd "$workspace_root" && pwd)"
    workspace_hooks="$workspace_root/.agents/hooks.json"
  fi

  resolve_node
  assert_timeout_budget

  HOOK_COMMAND="$(shell_quote "$NODE_BIN") $(shell_quote "$STAGE_INTERCEPTOR")"

  if [ -n "$workspace_hooks" ]; then
    warn_git_workspace "$workspace_root" "$workspace_hooks"
  fi

  if [ "$DRY_RUN" = "true" ]; then
    log "Dry run — nothing will be written."
    log "would copy $SRC_INTERCEPTOR -> $STAGE_INTERCEPTOR (mkdir -p $STAGE_DIR, mode 0700)"
    log "would use hook command: $HOOK_COMMAND (timeout ${HOOK_TIMEOUT_SECONDS}s)"
    log "would record the registration in $MANIFEST_FILE"
    if [ "$SCOPE" = "global" ] || [ "$SCOPE" = "both" ]; then
      merge_hooks "$GLOBAL_HOOKS" "print"
    fi
    if [ -n "$workspace_hooks" ]; then
      merge_hooks "$workspace_hooks" "print"
    fi
    warn_missing_api_key
    log "Dry run complete. Nothing was written."
    return 0
  fi

  if [ "$SCOPE" = "global" ] || [ "$SCOPE" = "both" ]; then
    validate_hooks "$GLOBAL_HOOKS"
  fi
  if [ -n "$workspace_hooks" ]; then
    validate_hooks "$workspace_hooks"
  fi

  # Explicit modes throughout: under `umask 000` the defaults would leave the
  # staged interceptor in a world-writable directory, i.e. anyone on the box
  # could swap the code that decides whether a tool call runs.
  if [ ! -d "$DENIED_HOME" ]; then
    mkdir -p "$DENIED_HOME" || die "could not create $DENIED_HOME. Check permissions on $HOME, then re-run."
    chmod 0700 "$DENIED_HOME" || warn "could not chmod 0700 $DENIED_HOME"
  fi
  mkdir -p "$STAGE_DIR" || die "could not create $STAGE_DIR. Check permissions on $DENIED_HOME, then re-run."
  chmod 0700 "$STAGE_DIR" || warn "could not chmod 0700 $STAGE_DIR — it holds the code that decides whether your agent's tool calls run."
  cp "$SRC_INTERCEPTOR" "$STAGE_INTERCEPTOR" || die "could not copy $SRC_INTERCEPTOR -> $STAGE_INTERCEPTOR"
  chmod 0644 "$STAGE_INTERCEPTOR" || warn "could not chmod 0644 $STAGE_INTERCEPTOR"
  log "Staged interceptor at $STAGE_INTERCEPTOR (dir mode 0700)"

  local written=()
  if [ "$SCOPE" = "global" ] || [ "$SCOPE" = "both" ]; then
    merge_hooks "$GLOBAL_HOOKS" "write"
    written+=("$GLOBAL_HOOKS")
  fi
  if [ -n "$workspace_hooks" ]; then
    merge_hooks "$workspace_hooks" "write"
    written+=("$workspace_hooks")
    log "Workspace trust: Antigravity loads $workspace_hooks only after you trust '$workspace_root' in the UI. Until the folder is trusted, workspace hooks do not run — and an untrusted workspace is therefore an ungated one."
  fi

  if [ "${#written[@]}" -gt 0 ]; then
    record_manifest "${written[@]}"
  fi

  warn_missing_api_key

  local check_status=0 target
  if [ "${#written[@]}" -gt 0 ]; then
    for target in "${written[@]}"; do
      self_check_target "$target" || check_status=1
    done
  fi
  if [ "$check_status" -eq 0 ]; then
    report_self_check_scope
  fi

  log "Restart any running 'agy' session (and the IDE, if you use it) — hooks.json is read at session start, so a live session keeps running ungated."
  if [ "$check_status" -ne 0 ]; then
    # Files are deliberately left in place — removing them mid-install could
    # strand a registration pointing at nothing — but the exit code stays
    # non-zero so a script or CI job never reads an unverified gate as a good
    # install.
    warn "Install completed with a FAILING self-check (see above). Every file listed above was written and left in place; the gate is registered but does not work."
    exit 1
  fi
  return 0
}

main "$@"
