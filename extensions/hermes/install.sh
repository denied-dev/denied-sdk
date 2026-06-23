#!/usr/bin/env bash
set -euo pipefail

DENIED_SDK_REPO="${DENIED_SDK_REPO:-https://github.com/denied-dev/denied-sdk}"
DENIED_SDK_REF="${DENIED_SDK_REF:-main}"
PLUGIN_NAME="denied"

log() {
  printf '[denied-hermes] %s\n' "$*"
}

die() {
  printf '[denied-hermes] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: extensions/hermes/install.sh [options]

Options:
  --hermes-home PATH  Hermes profile directory. Defaults to $HERMES_HOME or ~/.hermes.
  --repo URL          denied-sdk repository URL for curl/bootstrap installs.
  --ref REF           denied-sdk git ref for curl/bootstrap installs. Defaults to main.
  -h, --help          Show this help.

Environment:
  HERMES_HOME         Hermes profile directory.
  DENIED_SDK_REPO     Repository URL used by curl/bootstrap installs.
  DENIED_SDK_REF      Repository ref used by curl/bootstrap installs.
EOF
}

check_supported_platform() {
  case "$(uname -s 2>/dev/null || true)" in
    Darwin|Linux)
      ;;
    *)
      die "This installer supports macOS and Linux. On Windows, run it from WSL or install the Hermes plugin manually."
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

download_archive() {
  local archive_url="$1"
  local output="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$archive_url" -o "$output"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$output" "$archive_url"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$archive_url" "$output" <<'PY'
from pathlib import Path
from urllib.request import urlopen
import sys

url, output = sys.argv[1], Path(sys.argv[2])
with urlopen(url) as response:
    output.write_bytes(response.read())
PY
  else
    die "curl install requires curl, wget, or python3 to download ${archive_url}"
  fi
}

bootstrap_from_archive() {
  local repo_archive_base temp_dir archive archive_url extracted_root installer
  repo_archive_base="${DENIED_SDK_REPO%.git}"
  temp_dir="$(mktemp -d)"
  archive="$temp_dir/denied-sdk.tar.gz"
  archive_url="${repo_archive_base%/}/archive/${DENIED_SDK_REF}.tar.gz"

  cleanup_bootstrap() {
    rm -rf "$temp_dir"
  }
  trap cleanup_bootstrap EXIT

  log "Downloading denied-sdk ${DENIED_SDK_REF} from ${DENIED_SDK_REPO}"
  download_archive "$archive_url" "$archive"
  tar -xzf "$archive" -C "$temp_dir"

  extracted_root="$(find "$temp_dir" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  [ -n "$extracted_root" ] || die "downloaded archive did not contain a repository directory"

  installer="$extracted_root/extensions/hermes/install.sh"
  [ -f "$installer" ] || die "downloaded archive does not contain extensions/hermes/install.sh"

  log "Running installer from downloaded archive"
  bash "$installer" "$@"
}

find_repo_root() {
  local script_dir candidate
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  candidate="$(cd "$script_dir/../.." && pwd)"

  if [ -d "$candidate/python" ] && [ -d "$candidate/extensions/hermes/src/denied_hermes" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

copy_plugin_files() {
  local repo_root="$1"
  local plugin_dir="$2"
  local temp_plugin_dir

  temp_plugin_dir="$(mktemp -d "$(dirname "$plugin_dir")/${PLUGIN_NAME}.tmp.XXXXXX")"
  mkdir -p "$temp_plugin_dir/src"

  cp "$repo_root/extensions/hermes/__init__.py" \
    "$repo_root/extensions/hermes/plugin.yaml" \
    "$repo_root/extensions/hermes/README.md" \
    "$repo_root/extensions/hermes/pyproject.toml" \
    "$temp_plugin_dir/"
  cp -R "$repo_root/extensions/hermes/src/denied_hermes" "$temp_plugin_dir/src/"

  rm -rf "$plugin_dir"
  mv "$temp_plugin_dir" "$plugin_dir"
}

run_install() {
  local hermes_home="${HERMES_HOME:-$HOME/.hermes}"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --hermes-home)
        [ "$#" -ge 2 ] || die "--hermes-home requires a path"
        hermes_home="$2"
        shift 2
        ;;
      --repo)
        [ "$#" -ge 2 ] || die "--repo requires a URL"
        DENIED_SDK_REPO="$2"
        shift 2
        ;;
      --ref)
        [ "$#" -ge 2 ] || die "--ref requires a git ref"
        DENIED_SDK_REF="$2"
        shift 2
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

  local repo_root
  if ! repo_root="$(find_repo_root)"; then
    bootstrap_from_archive \
      --hermes-home "$hermes_home" \
      --repo "$DENIED_SDK_REPO" \
      --ref "$DENIED_SDK_REF"
    return
  fi

  hermes_home="$(abspath "${hermes_home/#\~/$HOME}")"

  local hermes_python="$hermes_home/hermes-agent/venv/bin/python"
  local plugin_dir="$hermes_home/plugins/$PLUGIN_NAME"

  [ -x "$hermes_python" ] || die "Hermes Python was not found at $hermes_python. Set HERMES_HOME or --hermes-home to the active Hermes profile."
  "$hermes_python" -m pip --version >/dev/null 2>&1 || die "pip is unavailable in Hermes Python venv at $hermes_python"

  log "Installing denied-sdk into Hermes Python"
  "$hermes_python" -m pip install "$repo_root/python"

  log "Installing plugin runtime package into Hermes Python"
  "$hermes_python" -m pip install "$repo_root/extensions/hermes"

  # The plugin is installed via BOTH mechanisms on purpose — they serve
  # different Hermes subsystems and are not redundant:
  #   * pip entry point  -> the runtime loader discovers + loads it (it scans
  #                         entry points and, on key collision, the entry point
  #                         wins, so it must resolve correctly — see below).
  #   * ~/.hermes/plugins -> the management CLI (`hermes plugins enable/
  #                         disable/list`) scans ONLY bundled + user
  #                         directories, never entry points, so the directory
  #                         copy is what makes the plugin CLI-manageable.
  # Drop either one and you lose runtime loading or CLI management respectively.
  log "Copying plugin files to $plugin_dir"
  mkdir -p "$(dirname "$plugin_dir")"
  copy_plugin_files "$repo_root" "$plugin_dir"

  # Verify the plugin the way Hermes' runtime loader actually resolves it: load
  # the entry point and confirm it yields a module exposing register(). A direct
  # ``import`` would pass even when the entry point is broken, giving false
  # confidence — the exact failure mode this plugin shipped with.
  log "Verifying plugin entry point resolves to a registrable module"
  "$hermes_python" - <<'PY'
import importlib.metadata as m

eps = [e for e in m.entry_points().select(group="hermes_agent.plugins") if e.name == "denied"]
assert eps, "denied entry point not found in group 'hermes_agent.plugins' after install"
module = eps[0].load()
register = getattr(module, "register", None)
assert callable(register), (
    f"entry point '{eps[0].value}' did not resolve to a module exposing "
    f"register(); Hermes would skip the plugin (got {register!r})"
)
PY

  if command -v hermes >/dev/null 2>&1; then
    log "Enabling Hermes plugin"
    HERMES_HOME="$hermes_home" hermes plugins enable "$PLUGIN_NAME"
  else
    log "Hermes CLI was not found. Enable the plugin manually with:"
    printf '  HERMES_HOME=%q hermes plugins enable %q\n' "$hermes_home" "$PLUGIN_NAME"
  fi

  log "Installed. Restart Hermes so the hook is loaded:"
  log "  CLI / gateway: hermes gateway restart   (add --all for every profile)"
  log "  Desktop app:   fully quit and reopen it (a new session is not enough)"
}

run_install "$@"
