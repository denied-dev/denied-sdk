#!/usr/bin/env bash
# Denied SDK — uninstaller for the Antigravity (`agy`) PreToolUse authorization hook.
#
# Removes only the "denied-authz" group from each target hooks.json, leaving any
# other hook group byte-for-byte semantically intact, and removes the staged
# interceptor. Your ~/.denied/config.json and audit logs are never touched.
set -euo pipefail

HOOK_GROUP="denied-authz"

DENIED_HOME="$HOME/.denied"
STAGE_DIR="$DENIED_HOME/antigravity"
STAGE_INTERCEPTOR="$STAGE_DIR/interceptor.js"
CONFIG_FILE="$DENIED_HOME/config.json"
GLOBAL_HOOKS="$HOME/.gemini/config/hooks.json"
AGY_NODE_SHIM="$HOME/Library/Application Support/Antigravity/bin/agy-node"

# Removal defaults to thorough: leaving a stale hook group behind in a scope the
# user forgot about is worse than removing one that was never there.
SCOPE="both"
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
Usage: extensions/antigravity/uninstall.sh [options]

Removes the Denied PreToolUse authorization hook for Google Antigravity.

Options:
  --scope SCOPE       Which registrations to remove: global | workspace | both.
                      Defaults to both.
  --workspace PATH    Workspace root for workspace scope. Defaults to $PWD.
  --node PATH         Node.js interpreter used to edit hooks.json. Defaults to
                      auto-detection; only needed if node is not on PATH.
  --dry-run           Print what would be removed and exit without changing
                      anything.
  -h, --help          Show this help.

Removed:
  the "denied-authz" group in ~/.gemini/config/hooks.json and/or
  <workspace>/.agents/hooks.json (the file itself only if it becomes empty)
  ~/.denied/antigravity/interceptor.js

Left alone:
  ~/.denied/config.json, ~/.denied/audit/, and every other hook group.
EOF
}

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

# Same resolution chain as install.sh. Unlike install, a missing Node is not
# fatal here: the staged files still come out, and the user gets the exact edit
# to make by hand rather than being stranded with a hook they cannot remove.
resolve_node() {
  local candidate
  if [ -n "$NODE_OVERRIDE" ]; then
    candidate="$NODE_OVERRIDE"
    if [ -x "$candidate" ] && node_is_supported "$candidate"; then
      NODE_BIN="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"
      return 0
    fi
    warn "--node '$candidate' is not a usable Node.js 18+ interpreter"
    return 1
  fi
  if candidate="$(command -v node 2>/dev/null)" && node_is_supported "$candidate"; then
    NODE_BIN="$candidate"
    return 0
  fi
  if [ -x "$AGY_NODE_SHIM" ] && node_is_supported "$AGY_NODE_SHIM"; then
    NODE_BIN="$AGY_NODE_SHIM"
    return 0
  fi
  return 1
}

# shellcheck disable=SC2016  # single quotes are deliberate: ${...} below are JS
# template literals, and the shell must not expand them.
PRUNE_JS='
const fs = require("node:fs");
const [target, group, mode] = process.argv.slice(1);
if (!fs.existsSync(target)) {
  process.stdout.write("absent\n");
  process.exit(0);
}
const raw = fs.readFileSync(target, "utf-8");
let existing = {};
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
if (!Object.prototype.hasOwnProperty.call(existing, group)) {
  process.stdout.write("untouched\n");
  process.exit(0);
}
delete existing[group];
const remaining = Object.keys(existing);
if (remaining.length === 0) {
  if (mode !== "print") {
    fs.unlinkSync(target);
  }
  process.stdout.write("emptied\n");
  process.exit(0);
}
const text = JSON.stringify(existing, null, 2) + "\n";
if (mode === "print") {
  process.stdout.write("pruned\n" + text);
  process.exit(0);
}
const tmp = `${target}.denied.${process.pid}.tmp`;
fs.writeFileSync(tmp, text);
fs.renameSync(tmp, target);
process.stdout.write("pruned " + remaining.join(", ") + "\n");
'

# prune_hooks <target> <mode:write|print>
prune_hooks() {
  local target="$1" mode="$2" out status
  if ! out="$("$NODE_BIN" -e "$PRUNE_JS" "$target" "$HOOK_GROUP" "$mode")"; then
    warn "left $target untouched — it is not valid JSON (see above). Remove the \"$HOOK_GROUP\" key by hand."
    return 1
  fi
  status="$(printf '%s\n' "$out" | head -n 1)"
  case "$status" in
    absent)
      log "No hooks.json at $target — nothing to remove"
      ;;
    untouched)
      log "No '$HOOK_GROUP' group in $target — left untouched"
      ;;
    emptied)
      if [ "$mode" = "print" ]; then
        log "would remove $target entirely ('$HOOK_GROUP' was its only group)"
      else
        log "Removed $target entirely ('$HOOK_GROUP' was its only group)"
      fi
      ;;
    pruned*)
      if [ "$mode" = "print" ]; then
        log "would rewrite $target without '$HOOK_GROUP':"
        printf '%s\n' "$out" | tail -n +2
      else
        log "Removed '$HOOK_GROUP' from $target (kept: ${status#pruned })"
      fi
      ;;
    *)
      log "$target: $status"
      ;;
  esac
  return 0
}

remove_staged_interceptor() {
  local mode="$1"
  if [ -e "$STAGE_INTERCEPTOR" ]; then
    if [ "$mode" = "print" ]; then
      log "would remove $STAGE_INTERCEPTOR"
    else
      rm -f "$STAGE_INTERCEPTOR"
      log "Removed $STAGE_INTERCEPTOR"
    fi
  else
    log "No staged interceptor at $STAGE_INTERCEPTOR"
  fi

  if [ -d "$STAGE_DIR" ]; then
    if [ "$mode" = "print" ]; then
      log "would remove $STAGE_DIR if empty"
    elif rmdir "$STAGE_DIR" 2>/dev/null; then
      log "Removed empty $STAGE_DIR"
    else
      log "Kept $STAGE_DIR (not empty)"
    fi
  fi
}

main() {
  parse_args "$@"

  local mode="write"
  if [ "$DRY_RUN" = "true" ]; then
    mode="print"
    log "Dry run — nothing will be removed."
  fi

  local targets=()
  if [ "$SCOPE" = "global" ] || [ "$SCOPE" = "both" ]; then
    targets+=("$GLOBAL_HOOKS")
  fi
  if [ "$SCOPE" = "workspace" ] || [ "$SCOPE" = "both" ]; then
    local workspace_root="${WORKSPACE:-$PWD}"
    if [ -d "$workspace_root" ]; then
      workspace_root="$(cd "$workspace_root" && pwd)"
      targets+=("$workspace_root/.agents/hooks.json")
    else
      warn "workspace '$workspace_root' is not a directory; skipping workspace scope"
    fi
  fi

  local failures=0

  if [ "${#targets[@]}" -eq 0 ]; then
    warn "no hooks.json targets to inspect for scope '$SCOPE'"
  elif resolve_node; then
    local target
    for target in "${targets[@]}"; do
      prune_hooks "$target" "$mode" || failures=$((failures + 1))
    done
  else
    failures=$((failures + 1))
    warn "no Node.js 18+ interpreter found, and hooks.json cannot be edited safely without one."
    warn "Remove the \"$HOOK_GROUP\" key by hand from:"
    local target
    for target in "${targets[@]}"; do
      if [ -f "$target" ]; then
        warn "  $target"
      else
        warn "  $target (absent — nothing to do)"
      fi
    done
    warn "If it is the only group in the file, delete the file instead."
    warn "Or re-run with --node /absolute/path/to/node."
  fi

  # Order matters: the staged interceptor goes only once every registration is
  # gone. A hooks.json still pointing at a deleted interceptor is the worst
  # possible end state — on agy <= 1.1.7 an unrunnable hook command denies every
  # tool call, so a half-finished uninstall would brick the agent.
  if [ "$failures" -eq 0 ]; then
    remove_staged_interceptor "$mode"
  else
    warn "keeping $STAGE_INTERCEPTOR in place: a registration still points at it, and a hook command that cannot run denies every tool call on agy <= 1.1.7. Resolve the items above, then re-run."
  fi

  log "Left alone: $CONFIG_FILE and $DENIED_HOME/audit/"
  log "Restart any running 'agy' session — a live session keeps the hook it started with."

  if [ "$failures" -gt 0 ]; then
    warn "Uninstall finished with $failures unresolved item(s) (see above)."
    exit 1
  fi
  return 0
}

main "$@"
