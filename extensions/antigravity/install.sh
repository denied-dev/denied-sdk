#!/usr/bin/env bash
# Denied SDK — installer for the Antigravity (`agy`) PreToolUse authorization hook.
#
# Stages the zero-dependency interceptor into ~/.denied/antigravity/ and merges a
# "denied-authz" group into the target hooks.json files. It never clobbers other
# hook groups, never points hooks.json into a git checkout, and never writes a
# `command` it could not verify is runnable — on agy <= 1.1.7 an unrunnable hook
# denies every tool call, and on 1.1.10 it silently enforces nothing.
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
CONFIG_FILE="$DENIED_HOME/config.json"
GLOBAL_HOOKS="$HOME/.gemini/config/hooks.json"
AGY_NODE_SHIM="$HOME/Library/Application Support/Antigravity/bin/agy-node"

SCOPE="global"
WORKSPACE=""
NODE_OVERRIDE=""
DRY_RUN="false"
NODE_BIN=""

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
  --scope SCOPE       Where to register the hook: global | workspace | both.
                      Defaults to global (~/.gemini/config/hooks.json).
  --workspace PATH    Workspace root for workspace scope. Defaults to $PWD.
                      Registers in <workspace>/.agents/hooks.json.
  --node PATH         Absolute path to the Node.js 18+ interpreter to bake into
                      the hook command. Defaults to auto-detection.
  --dry-run           Print the exact files and JSON that would be written and
                      exit without touching anything.
  -h, --help          Show this help.

Files written:
  ~/.denied/antigravity/interceptor.js       staged interceptor (never the checkout)
  ~/.gemini/config/hooks.json                global scope
  <workspace>/.agents/hooks.json             workspace scope

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

resolve_node() {
  local candidate major

  if [ -n "$NODE_OVERRIDE" ]; then
    candidate="$NODE_OVERRIDE"
    [ -x "$candidate" ] || die "--node '$candidate' is not an executable file"
    major="$(node_major "$candidate")" ||
      die "--node '$candidate' did not report a Node.js version; it does not look like a Node interpreter"
    [ "$major" -ge 18 ] ||
      die "--node '$candidate' is Node $major; the interceptor requires Node 18+ (native fetch)"
    NODE_BIN="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"
    log "Node interpreter: $NODE_BIN (from --node)"
    return 0
  fi

  if candidate="$(command -v node 2>/dev/null)" && node_is_supported "$candidate"; then
    NODE_BIN="$candidate"
    log "Node interpreter: $NODE_BIN (from PATH, v$(node_major "$candidate"))"
    return 0
  fi

  # macOS: the Electron-as-Node shim the IDE itself ships.
  if [ -x "$AGY_NODE_SHIM" ] && node_is_supported "$AGY_NODE_SHIM"; then
    NODE_BIN="$AGY_NODE_SHIM"
    log "Node interpreter: $NODE_BIN (Antigravity's bundled shim)"
    return 0
  fi

  die "no usable Node.js 18+ interpreter found.
  Looked at: \$(command -v node), $AGY_NODE_SHIM
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

# shellcheck disable=SC2016  # single quotes are deliberate: ${...} below are JS
# template literals, and the shell must not expand them.
MERGE_JS='
const fs = require("node:fs");
const path = require("node:path");
const [target, group, command, timeoutRaw, mode] = process.argv.slice(1);
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
if (fs.existsSync(target)) {
  existed = true;
  const raw = fs.readFileSync(target, "utf-8");
  if (raw.trim() !== "") {
    try {
      existing = JSON.parse(raw);
    } catch (err) {
      console.error(`${target} is not valid JSON: ${err.message}`);
      process.exit(3);
    }
    if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
      console.error(`${target} is not a JSON object; hooks.json must be a map of named hook groups`);
      process.exit(3);
    }
  }
}
const had = Object.prototype.hasOwnProperty.call(existing, group);
const merged = { ...existing, [group]: entry };
const text = JSON.stringify(merged, null, 2) + "\n";
const status = existed ? (had ? "replaced" : "merged") : "created";
if (mode === "print") {
  process.stdout.write(status + "\n" + text);
  process.exit(0);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
if (existed && !fs.existsSync(target + ".bak")) {
  fs.copyFileSync(target, target + ".bak");
}
const tmp = `${target}.denied.${process.pid}.tmp`;
fs.writeFileSync(tmp, text);
fs.renameSync(tmp, target);
process.stdout.write(status + "\n");
'

# merge_hooks <target> <mode:write|print>
merge_hooks() {
  local target="$1" mode="$2" out status
  if ! out="$("$NODE_BIN" -e "$MERGE_JS" "$target" "$HOOK_GROUP" "$NODE_BIN $STAGE_INTERCEPTOR" "$HOOK_TIMEOUT_SECONDS" "$mode")"; then
    die "refusing to touch $target — see the parse error above. Fix or move the file, then re-run; guessing at its intended contents could silently drop your other hooks."
  fi
  status="$(printf '%s\n' "$out" | head -n 1)"
  if [ "$mode" = "print" ]; then
    log "would write $target ($status):"
    printf '%s\n' "$out" | tail -n +2
  else
    case "$status" in
      created) log "Created $target" ;;
      merged) log "Merged '$HOOK_GROUP' into $target (existing groups preserved, backup at $target.bak)" ;;
      replaced) log "Replaced the existing '$HOOK_GROUP' group in $target (other groups preserved, backup at $target.bak)" ;;
      *) log "Wrote $target" ;;
    esac
  fi
}

# Pre-flight: parse every target before anything is written, so a corrupt
# hooks.json aborts the install cleanly instead of half-way through it.
validate_hooks() {
  local target="$1"
  "$NODE_BIN" -e "$MERGE_JS" "$target" "$HOOK_GROUP" "x" "$HOOK_TIMEOUT_SECONDS" "print" >/dev/null ||
    die "refusing to touch $target — see the parse error above. Fix or move the file, then re-run; guessing at its intended contents could silently drop your other hooks."
}

# ---------------------------------------------------------------------------
# Config warning
# ---------------------------------------------------------------------------

warn_missing_api_key() {
  local has_key="no"
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
      has_key="yes"
    fi
  fi

  if [ "$has_key" = "yes" ]; then
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

self_check() {
  local payload='{"toolCall":{"name":"denied-install-check","args":{}},"conversationId":"denied-install-check"}'
  local tmp_dir stdout_file stderr_file status=0

  tmp_dir="$(mktemp -d)"
  stdout_file="$tmp_dir/stdout"
  stderr_file="$tmp_dir/stderr"

  log "Running self-check against the staged interceptor"
  printf '%s' "$payload" | "$NODE_BIN" "$STAGE_INTERCEPTOR" >"$stdout_file" 2>"$stderr_file" || status=$?

  if [ "$status" -ne 0 ]; then
    warn "self-check FAILED: the interceptor exited $status (it must always exit 0)."
    warn "Its stderr:"
    sed 's/^/  /' "$stderr_file" >&2 || true
    warn "The hook is installed and left in place, but verify it before relying on it."
    rm -rf "$tmp_dir"
    return 1
  fi

  local decision
  # shellcheck disable=SC2016  # JS source, not a shell expansion
  if ! decision="$("$NODE_BIN" -e '
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
  ' "$stdout_file" 2>/dev/null)"; then
    warn "self-check FAILED: the interceptor did not print a decision object on stdout."
    warn "  $decision"
    warn "Its stderr:"
    sed 's/^/  /' "$stderr_file" >&2 || true
    warn "The hook is installed and left in place, but verify it before relying on it."
    rm -rf "$tmp_dir"
    return 1
  fi

  log "Self-check passed: decision = $decision"
  if [ -s "$stderr_file" ]; then
    log "Interceptor diagnostics (stderr):"
    sed 's/^/  /' "$stderr_file"
  fi
  rm -rf "$tmp_dir"
  return 0
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

  if [ "$DRY_RUN" = "true" ]; then
    log "Dry run — nothing will be written."
    log "would copy $SRC_INTERCEPTOR -> $STAGE_INTERCEPTOR (mkdir -p $STAGE_DIR)"
    log "would use hook command: $NODE_BIN $STAGE_INTERCEPTOR (timeout ${HOOK_TIMEOUT_SECONDS}s)"
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

  mkdir -p "$STAGE_DIR"
  cp "$SRC_INTERCEPTOR" "$STAGE_INTERCEPTOR"
  chmod 0644 "$STAGE_INTERCEPTOR"
  log "Staged interceptor at $STAGE_INTERCEPTOR"

  if [ "$SCOPE" = "global" ] || [ "$SCOPE" = "both" ]; then
    merge_hooks "$GLOBAL_HOOKS" "write"
  fi
  if [ -n "$workspace_hooks" ]; then
    merge_hooks "$workspace_hooks" "write"
    log "Workspace trust: Antigravity loads $workspace_hooks only after you trust '$workspace_root' in the UI. Until the folder is trusted, workspace hooks do not run — and an untrusted workspace is therefore an ungated one."
  fi

  warn_missing_api_key

  local check_status=0
  self_check || check_status=$?

  log "Restart any running 'agy' session (and the IDE, if you use it) — hooks.json is read at session start, so a live session keeps running ungated."
  if [ "$check_status" -ne 0 ]; then
    # Files are deliberately left in place — removing them mid-uninstall could
    # strand a registration pointing at nothing — but the exit code stays
    # non-zero so a script or CI job never reads an unverified gate as a good
    # install.
    warn "Install completed with a FAILING self-check (see above). Every file listed above was written and left in place; the gate is registered but unverified."
    exit 1
  fi
  return 0
}

main "$@"
