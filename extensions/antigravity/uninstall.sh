#!/usr/bin/env bash
# Denied SDK — uninstaller for the Antigravity (`agy`) PreToolUse authorization hook.
#
# Removes only the "denied-authz" group from each target hooks.json, leaving any
# other hook group semantically intact, and removes the staged interceptor. Your
# ~/.denied/config.json and audit logs are never touched.
#
# The staged interceptor is GLOBAL state while --scope is not: it is deleted only
# after every known registration — in every scope, not just the selected ones —
# has been confirmed gone. A hooks.json pointing at a deleted interceptor is the
# worst end state there is: on agy <= 1.1.7 an unrunnable hook command denies
# every tool call, so it bricks the agent.
set -euo pipefail

HOOK_GROUP="denied-authz"

DENIED_HOME="$HOME/.denied"
STAGE_DIR="$DENIED_HOME/antigravity"
STAGE_INTERCEPTOR="$STAGE_DIR/interceptor.js"
MANIFEST_FILE="$STAGE_DIR/install-manifest.json"
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
  ~/.denied/antigravity/interceptor.js, but only once no other scope still
  registers it — otherwise it is kept and you are told which scope holds it

Left alone:
  ~/.denied/config.json, ~/.denied/audit/, any hooks.json.bak the installer
  made, and every other hook group.
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
      NODE_BIN="$candidate"
      return 0
    fi
    warn "--node '$candidate' is not a usable Node.js 18+ interpreter"
    return 1
  fi
  if ! candidate="$(type -P node 2>/dev/null)" || [ -z "$candidate" ]; then
    candidate="$(command -v node 2>/dev/null || true)"
  fi
  if [ -n "$candidate" ] && [ -x "$candidate" ] && node_is_supported "$candidate"; then
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
const path = require("node:path");
const [target, group, mode] = process.argv.slice(1);

const note = (msg) => process.stderr.write(`[denied] ${msg}\n`);

// A hooks.json symlinked into a dotfiles repo is edited THROUGH the link: the
// link itself is never unlinked or replaced. Unlinking it would leave the real
// file — still carrying this hook group — sitting in the dotfiles repo, so
// re-linking later would silently resurrect a registration the user removed.
let realTarget = target;
let viaSymlink = false;
try {
  const st = fs.lstatSync(target);
  if (st.isSymbolicLink()) {
    viaSymlink = true;
    try {
      realTarget = fs.realpathSync(target);
    } catch {
      realTarget = path.resolve(path.dirname(target), fs.readlinkSync(target));
    }
    note(`${target} is a symlink -> ${realTarget}; editing through it (the symlink itself is left in place).`);
  }
} catch {
  /* absent */
}

if (!fs.existsSync(realTarget)) {
  process.stdout.write("absent\n");
  process.exit(0);
}
const raw = fs.readFileSync(realTarget, "utf-8");
let existing = {};
if (raw.trim() !== "") {
  try {
    existing = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[denied] error: ${realTarget} is not valid JSON: ${err.message}\n`);
    process.exit(3);
  }
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
    process.stderr.write(`[denied] error: ${realTarget} is not a JSON object; hooks.json must be a map of named hook groups\n`);
    process.exit(3);
  }
}
if (!Object.prototype.hasOwnProperty.call(existing, group)) {
  process.stdout.write("untouched\n");
  process.exit(0);
}
delete existing[group];
const remaining = Object.keys(existing);

let targetMode = null;
try {
  targetMode = fs.statSync(realTarget).mode & 0o7777;
} catch {
  targetMode = null;
}
const writeThrough = (text) => {
  const tmp = `${realTarget}.denied.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.chmodSync(tmp, targetMode === null ? 0o644 : targetMode);
    fs.renameSync(tmp, realTarget);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    process.stderr.write(`[denied] error: could not write ${realTarget}: ${err.message}\n`);
    process.exit(4);
  }
};

if (remaining.length === 0) {
  if (viaSymlink) {
    // Deleting the link target would leave a dangling symlink where the host
    // expects a file; emptying it removes the registration without breaking
    // the user own arrangement.
    if (mode !== "print") writeThrough("{}\n");
    process.stdout.write("emptied-symlink\n");
    process.exit(0);
  }
  if (mode !== "print") {
    try {
      fs.unlinkSync(realTarget);
    } catch (err) {
      process.stderr.write(`[denied] error: could not remove ${realTarget}: ${err.message}\n`);
      process.exit(4);
    }
  }
  process.stdout.write("emptied\n");
  process.exit(0);
}

// Parse-and-reserialize is not byte preservation. Unlike install, removal is
// not refused over it — leaving the gate registered would be worse — but any
// change to a neighbouring group is stated rather than made silently.
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
    note(`LOSSY rewrite of ${realTarget}: the number ${lit} is being rewritten as null (JSON.parse cannot represent it). The pre-uninstall file is still at ${realTarget}.bak if the installer made one.`);
  } else if (/^-?\d+$/.test(lit) && !Number.isSafeInteger(n) && JSON.stringify(n) !== lit) {
    note(`LOSSY rewrite of ${realTarget}: the integer ${lit} is being rewritten as ${JSON.stringify(n)} (precision lost).`);
  }
}

const text = JSON.stringify(existing, null, 2) + "\n";
if (mode === "print") {
  process.stdout.write("pruned\n" + text);
  process.exit(0);
}
writeThrough(text);
process.stdout.write("pruned " + remaining.join(", ") + "\n");
'

# Answers one question about one file: does it still register our hook group?
# Exit 0 = yes, 1 = no, 2 = cannot tell. "Cannot tell" counts as yes.
# shellcheck disable=SC2016  # JS source, not a shell expansion
HAS_GROUP_JS='
const fs = require("node:fs");
const [target, group] = process.argv.slice(1);
if (!fs.existsSync(target)) process.exit(1);
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(target, "utf-8") || "{}");
} catch {
  process.exit(2);
}
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) process.exit(2);
process.exit(Object.prototype.hasOwnProperty.call(parsed, group) ? 0 : 1);
'

# Reads the install manifest and prints one registered hooks.json path per line.
# shellcheck disable=SC2016  # JS source, not a shell expansion
MANIFEST_READ_JS='
const fs = require("node:fs");
try {
  const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
  const targets = parsed && Array.isArray(parsed.targets) ? parsed.targets : [];
  for (const t of targets) {
    if (typeof t === "string" && t && !t.includes("\n")) process.stdout.write(t + "\n");
  }
} catch {
  /* no manifest (or an install made before manifests existed): print nothing */
}
'

# Drops the given paths from the manifest target list.
# shellcheck disable=SC2016  # JS source, not a shell expansion
MANIFEST_PRUNE_JS='
const fs = require("node:fs");
const [file, ...removed] = process.argv.slice(1);
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
} catch {
  process.exit(0);
}
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) process.exit(0);
const targets = Array.isArray(parsed.targets) ? parsed.targets : [];
parsed.targets = targets.filter((t) => typeof t === "string" && !removed.includes(t));
parsed.updatedAt = new Date().toISOString();
const tmp = `${file}.denied.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(tmp, file);
'

# prune_hooks <target> <mode:write|print>
prune_hooks() {
  local target="$1" mode="$2" out status rc=0
  out="$("$NODE_BIN" -e "$PRUNE_JS" "$target" "$HOOK_GROUP" "$mode")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$rc" in
      3) warn "left $target untouched — it is not usable hooks.json (see the parse error above). Remove the \"$HOOK_GROUP\" key by hand." ;;
      4) warn "left $target untouched — it could not be written (see the filesystem error above). Check permissions and free space, then re-run." ;;
      *) warn "left $target untouched — node exited $rc (see the error above)." ;;
    esac
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
    emptied-symlink)
      if [ "$mode" = "print" ]; then
        log "would empty $target to {} through its symlink ('$HOOK_GROUP' was its only group; the symlink is kept)"
      else
        log "Emptied $target to {} through its symlink ('$HOOK_GROUP' was its only group; the symlink is kept)"
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

# has_registration <target> — 0 if our group is (or may still be) there.
has_registration() {
  local target="$1" rc=0
  "$NODE_BIN" -e "$HAS_GROUP_JS" "$target" "$HOOK_GROUP" || rc=$?
  case "$rc" in
    0) return 0 ;;
    1) return 1 ;;
    *)
      warn "could not read $target to check whether it still registers '$HOOK_GROUP'; assuming it does."
      return 0
      ;;
  esac
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

  if [ -e "$MANIFEST_FILE" ]; then
    if [ "$mode" = "print" ]; then
      log "would remove $MANIFEST_FILE"
    else
      rm -f "$MANIFEST_FILE"
      log "Removed $MANIFEST_FILE"
    fi
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

# list_contains <needle> <haystack...>
list_contains() {
  local needle="$1" item
  shift
  for item in "$@"; do
    [ "$item" = "$needle" ] || continue
    return 0
  done
  return 1
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
  local workspace_hooks=""
  if [ "$SCOPE" = "workspace" ] || [ "$SCOPE" = "both" ]; then
    local workspace_root="${WORKSPACE:-$PWD}"
    if [ -d "$workspace_root" ]; then
      workspace_root="$(cd "$workspace_root" && pwd)"
      workspace_hooks="$workspace_root/.agents/hooks.json"
      targets+=("$workspace_hooks")
    else
      warn "workspace '$workspace_root' is not a directory; skipping workspace scope"
    fi
  fi

  local failures=0
  local handled=()
  local have_node="no"

  if resolve_node; then
    have_node="yes"
  fi

  if [ "$have_node" != "yes" ]; then
    failures=$((failures + 1))
    warn "no Node.js 18+ interpreter found, and hooks.json cannot be edited safely without one."
    warn "Remove the \"$HOOK_GROUP\" key by hand from:"
    local target
    if [ "${#targets[@]}" -gt 0 ]; then
      for target in "${targets[@]}"; do
        if [ -f "$target" ]; then
          warn "  $target"
        else
          warn "  $target (absent — nothing to do)"
        fi
      done
    fi
    warn "If it is the only group in the file, delete the file instead."
    warn "Or re-run with --node /absolute/path/to/node."
  elif [ "${#targets[@]}" -eq 0 ]; then
    warn "no hooks.json targets to inspect for scope '$SCOPE'"
  else
    local target
    for target in "${targets[@]}"; do
      if prune_hooks "$target" "$mode"; then
        handled+=("$target")
      else
        failures=$((failures + 1))
      fi
    done
  fi

  # The staged interceptor is shared by every scope, so "did the selected scope
  # come out cleanly" is the wrong question — a scope that was never EXAMINED
  # contributes no failures and would let the interceptor be deleted out from
  # under a live registration. Every scope this install could have touched is
  # checked here: the manifest written by install.sh, plus the well-known global
  # and workspace paths for installs made before the manifest existed.
  local survivors=()
  local scan_incomplete="no"
  if [ "$have_node" = "yes" ]; then
    local candidates=()
    candidates+=("$GLOBAL_HOOKS")
    if [ -n "$workspace_hooks" ]; then
      candidates+=("$workspace_hooks")
    fi
    if [ -z "$workspace_hooks" ] && [ "$SCOPE" = "global" ]; then
      local pwd_hooks
      pwd_hooks="$PWD/.agents/hooks.json"
      candidates+=("$pwd_hooks")
    fi
    if [ -f "$MANIFEST_FILE" ]; then
      local manifest_target
      while IFS= read -r manifest_target; do
        [ -n "$manifest_target" ] || continue
        candidates+=("$manifest_target")
      done < <("$NODE_BIN" -e "$MANIFEST_READ_JS" "$MANIFEST_FILE" 2>/dev/null || true)
    else
      scan_incomplete="yes"
    fi

    local candidate
    for candidate in "${candidates[@]}"; do
      # In write mode a successfully handled target no longer registers us; in
      # dry-run it still does on disk, so skip it the same way and report what
      # the run WOULD leave behind.
      if [ "${#handled[@]}" -gt 0 ] && list_contains "$candidate" "${handled[@]}"; then
        continue
      fi
      if [ "${#survivors[@]}" -gt 0 ] && list_contains "$candidate" "${survivors[@]}"; then
        continue
      fi
      if [ -e "$candidate" ] && has_registration "$candidate"; then
        survivors+=("$candidate")
      fi
    done
  else
    scan_incomplete="yes"
  fi

  # Order matters: the staged interceptor goes only once every registration is
  # gone. A hooks.json still pointing at a deleted interceptor is the worst
  # possible end state — on agy <= 1.1.7 an unrunnable hook command denies every
  # tool call, so a half-finished uninstall would brick the agent.
  if [ "${#survivors[@]}" -gt 0 ]; then
    local survivor
    warn "keeping $STAGE_INTERCEPTOR: '$HOOK_GROUP' is still registered in:"
    for survivor in "${survivors[@]}"; do
      warn "  $survivor"
    done
    if [ "$failures" -eq 0 ]; then
      warn "That registration is outside the scope you asked to remove ('$SCOPE'), so this is a partial uninstall and the interceptor it points at must stay. Deleting it would leave a hook command that cannot run — which denies every tool call on agy <= 1.1.7."
      warn "Run './uninstall.sh --scope both' (optionally with --workspace PATH) to remove everything."
    else
      warn "Resolve the failures above, then re-run."
    fi
  elif [ "$failures" -eq 0 ]; then
    if [ "$scan_incomplete" = "yes" ] && [ "$have_node" = "yes" ]; then
      warn "no install manifest at $MANIFEST_FILE (an older install, or it was removed), so only the standard global and workspace paths could be checked. If you registered the hook in some other workspace, remove it there too."
    fi
    remove_staged_interceptor "$mode"
  else
    warn "keeping $STAGE_INTERCEPTOR in place: a registration may still point at it, and a hook command that cannot run denies every tool call on agy <= 1.1.7. Resolve the items above, then re-run."
  fi

  if [ "$mode" != "print" ] && [ "${#handled[@]}" -gt 0 ] && [ "$have_node" = "yes" ] && [ -f "$MANIFEST_FILE" ]; then
    "$NODE_BIN" -e "$MANIFEST_PRUNE_JS" "$MANIFEST_FILE" "${handled[@]}" 2>/dev/null ||
      warn "could not update $MANIFEST_FILE"
  fi

  # The installer copies the pre-install hooks.json to <target>.bak once. It is
  # the user's own prior state, so it is reported rather than deleted.
  if [ "${#targets[@]}" -gt 0 ]; then
    local bak_target
    for bak_target in "${targets[@]}"; do
      if [ -f "$bak_target.bak" ]; then
        log "Left $bak_target.bak (your pre-install hooks.json, made by install.sh). Delete it once you are happy: rm '$bak_target.bak'"
      fi
    done
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
