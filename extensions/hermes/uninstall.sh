#!/usr/bin/env bash
set -euo pipefail

# Reverses extensions/hermes/install.sh. The installer touches several distinct
# Hermes subsystems, so a complete uninstall has to undo each one:
#   1. pip package  denied-hermes-plugin   (Hermes venv)        -> runtime loader
#   2. pip package  denied-sdk             (Hermes venv)        -> dependency
#   3. directory    ~/.hermes/plugins/denied                    -> CLI-manageable copy
#   4. config.yaml  plugins.enabled / plugins.disabled entries  -> activation gate
#   5. config/data  ~/.hermes/denied.json (+ .bak), denied-audit -> runtime config
#   6. allowlist    shell-hooks-allowlist.json denied entry      -> legacy JS hook approval
#
# Unlike install.sh there is nothing to download — uninstall operates purely on a
# local Hermes profile, so there is no curl/bootstrap path.

PLUGIN_NAME="denied"

# By default we keep denied-sdk (a generic SDK that other code may import) and we
# DO remove the denied.json config + audit data. Flags below flip those choices.
PURGE_SDK=0
KEEP_CONFIG=0

log() {
  printf '[denied-hermes] %s\n' "$*"
}

warn() {
  printf '[denied-hermes] warning: %s\n' "$*" >&2
}

die() {
  printf '[denied-hermes] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: extensions/hermes/uninstall.sh [options]

Removes the Denied Hermes plugin and every artifact install.sh created.

Options:
  --hermes-home PATH  Hermes profile directory. Defaults to $HERMES_HOME or ~/.hermes.
  --purge-sdk         Also uninstall the denied-sdk package from the Hermes venv.
                      Off by default since other code may import denied_sdk.
  --keep-config       Keep ~/.hermes/denied.json (+ backups) and the denied-audit
                      directory instead of deleting them.
  -h, --help          Show this help.

Environment:
  HERMES_HOME         Hermes profile directory.
EOF
}

check_supported_platform() {
  case "$(uname -s 2>/dev/null || true)" in
    Darwin|Linux)
      ;;
    *)
      die "This uninstaller supports macOS and Linux. On Windows, run it from WSL or remove the Hermes plugin manually."
      ;;
  esac
}

abspath() {
  local path="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$path"
  else
    (cd "$path" && pwd)
  fi
}

# Remove 'denied' from BOTH plugins.enabled and plugins.disabled using Hermes'
# own config helpers, so the file is rewritten exactly the way Hermes writes it.
# `hermes plugins remove` only deletes the directory, and `disable` would leave a
# stale entry in plugins.disabled — neither fully cleans config on its own.
clean_config() {
  local hermes_python="$1"
  local hermes_home="$2"

  if ! "$hermes_python" -c "import hermes_cli.config" >/dev/null 2>&1; then
    warn "Could not import hermes_cli.config; leaving config.yaml untouched."
    warn "Remove '$PLUGIN_NAME' from plugins.enabled/disabled in $hermes_home/config.yaml manually."
    return 0
  fi

  HERMES_HOME="$hermes_home" "$hermes_python" - "$PLUGIN_NAME" <<'PY'
import sys

from hermes_cli.config import load_config, save_config

name = sys.argv[1]
config = load_config()
plugins = config.get("plugins")
if not isinstance(plugins, dict):
    sys.exit(0)

changed = False
for key in ("enabled", "disabled"):
    values = plugins.get(key)
    if isinstance(values, list) and name in values:
        plugins[key] = [v for v in values if v != name]
        changed = True

if changed:
    save_config(config)
    print(f"[denied-hermes] Removed '{name}' from plugins.enabled/disabled")
else:
    print(f"[denied-hermes] '{name}' not present in plugins.enabled/disabled")
PY
}

# Drop any shell-hooks allowlist approval that points at the legacy denied JS
# hook. The hook file itself is no longer shipped, but a stale approval lingers.
clean_allowlist() {
  local hermes_python="$1"
  local allowlist="$2"

  [ -f "$allowlist" ] || return 0

  "$hermes_python" - "$allowlist" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    data = json.loads(path.read_text())
except (OSError, ValueError):
    sys.exit(0)

approvals = data.get("approvals")
if not isinstance(approvals, list):
    sys.exit(0)

kept = [a for a in approvals if "denied-hermes-hook" not in str(a.get("command", ""))]
if len(kept) != len(approvals):
    data["approvals"] = kept
    path.write_text(json.dumps(data, indent=2) + "\n")
    print(f"[denied-hermes] Removed {len(approvals) - len(kept)} denied entry(ies) from {path.name}")
PY
}

run_uninstall() {
  local hermes_home="${HERMES_HOME:-$HOME/.hermes}"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --hermes-home)
        [ "$#" -ge 2 ] || die "--hermes-home requires a path"
        hermes_home="$2"
        shift 2
        ;;
      --purge-sdk)
        PURGE_SDK=1
        shift
        ;;
      --keep-config)
        KEEP_CONFIG=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown option: $1"
        ;;
    esac
  done

  check_supported_platform

  hermes_home="$(abspath "${hermes_home/#\~/$HOME}")"
  [ -d "$hermes_home" ] || die "Hermes profile not found at $hermes_home. Set HERMES_HOME or --hermes-home."

  local hermes_python="$hermes_home/hermes-agent/venv/bin/python"
  local plugin_dir="$hermes_home/plugins/$PLUGIN_NAME"
  local allowlist="$hermes_home/shell-hooks-allowlist.json"

  local have_python=0
  if [ -x "$hermes_python" ] && "$hermes_python" -m pip --version >/dev/null 2>&1; then
    have_python=1
  else
    warn "Hermes Python/pip not usable at $hermes_python; skipping pip + config/allowlist steps."
  fi

  # 1 + 2. Uninstall pip packages from the Hermes venv.
  if [ "$have_python" -eq 1 ]; then
    if "$hermes_python" -m pip show denied-hermes-plugin >/dev/null 2>&1; then
      log "Uninstalling denied-hermes-plugin from Hermes Python"
      "$hermes_python" -m pip uninstall -y denied-hermes-plugin
    else
      log "denied-hermes-plugin not installed in Hermes Python"
    fi

    if [ "$PURGE_SDK" -eq 1 ]; then
      if "$hermes_python" -m pip show denied-sdk >/dev/null 2>&1; then
        log "Uninstalling denied-sdk from Hermes Python (--purge-sdk)"
        "$hermes_python" -m pip uninstall -y denied-sdk
      else
        log "denied-sdk not installed in Hermes Python"
      fi
    else
      log "Keeping denied-sdk (pass --purge-sdk to remove it)"
    fi
  fi

  # 3. Remove the directory-based plugin copy.
  if [ -d "$plugin_dir" ]; then
    log "Removing plugin directory $plugin_dir"
    rm -rf "$plugin_dir"
  else
    log "Plugin directory $plugin_dir already absent"
  fi

  # 4. Strip the activation entries from config.yaml.
  if [ "$have_python" -eq 1 ]; then
    log "Cleaning plugins.enabled/disabled in config.yaml"
    clean_config "$hermes_python" "$hermes_home"

    # 6. Drop the stale legacy JS-hook approval.
    log "Cleaning shell-hooks allowlist"
    clean_allowlist "$hermes_python" "$allowlist"
  fi

  # 5. Remove runtime config + audit data (holds the API key).
  if [ "$KEEP_CONFIG" -eq 1 ]; then
    log "Keeping denied.json and denied-audit (--keep-config)"
  else
    local removed_any=0
    for path in "$hermes_home/denied.json" "$hermes_home"/denied.json.bak.* "$hermes_home/denied-audit"; do
      if [ -e "$path" ]; then
        rm -rf "$path"
        removed_any=1
      fi
    done
    if [ "$removed_any" -eq 1 ]; then
      log "Removed denied.json (+ backups) and denied-audit"
      warn "If the API key in the removed denied.json was real, rotate it at https://app.denied.dev."
    else
      log "No denied.json / denied-audit data to remove"
    fi
  fi

  log "Uninstalled. Restart Hermes so the hook is dropped:"
  log "  CLI / gateway: hermes gateway restart   (add --all for every profile)"
  log "  Desktop app:   fully quit and reopen it (a new session is not enough)"
}

run_uninstall "$@"
