#!/bin/sh
set -eu

release_id="pi-v0.81.1-patch.6"
pi_version="0.81.1"
payload_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
usage="Usage: install.sh [install|verify|activate|uninstall] [--install-dir PATH] [--bin-dir PATH] | install.sh --manage-pi <signed managed-install options>"
action=${1:-install}
if [ "$#" -gt 0 ]; then shift; fi

if [ "$action" = "--manage-pi" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "pi-wait-for-user: managed installation requires Node.js 22.19 or newer" >&2
    exit 1
  fi
  exec node "$payload_dir/managed-bootstrap/managed-installer.mjs" --manage-pi "$@"
fi

case "$(uname -s)" in
  Darwin) data_root="$HOME/Library/Application Support" ;;
  Linux) data_root="${XDG_DATA_HOME:-$HOME/.local/share}" ;;
  *) echo "pi-wait-for-user: binary installation supports macOS and Linux" >&2; exit 1 ;;
esac

install_dir="$data_root/pi-wait-for-user/releases/$release_id"
bin_dir="$HOME/.local/bin"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir) install_dir=$2; shift 2 ;;
    --bin-dir) bin_dir=$2; shift 2 ;;
    *) echo "$usage" >&2; exit 1 ;;
  esac
done

launcher="$bin_dir/pi-wait-for-user"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Darwin-x86_64) platform=darwin-x64 ;;
  Linux-aarch64|Linux-arm64) platform=linux-arm64 ;;
  Linux-x86_64) platform=linux-x64 ;;
  *) echo "pi-wait-for-user: unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

verify_directory() {
  directory=$1
  test -x "$directory/pi-wait-for-user" || { echo "pi-wait-for-user: launcher is missing" >&2; return 1; }
  test -x "$directory/pi-core" || { echo "pi-wait-for-user: core binary is missing" >&2; return 1; }
  test -f "$directory/question-tool/extensions/question-tool.ts" || {
    echo "pi-wait-for-user: Question Tool is missing" >&2
    return 1
  }
  grep -q "\"releaseId\": \"$release_id\"" "$directory/release.json" || {
    echo "pi-wait-for-user: release identity mismatch" >&2
    return 1
  }
  grep -q "\"platform\": \"$platform\"" "$directory/release.json" || {
    echo "pi-wait-for-user: binary platform mismatch" >&2
    return 1
  }
  version=$("$directory/pi-wait-for-user" --version)
  test "$version" = "$pi_version" || {
    echo "pi-wait-for-user: expected Pi $pi_version, found $version" >&2
    return 1
  }
}

launcher_available() {
  if [ ! -e "$launcher" ] && [ ! -L "$launcher" ]; then
    return 0
  fi
  if [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$install_dir/pi-wait-for-user" ]; then
    return 0
  fi
  echo "pi-wait-for-user: unowned foreign command collision: $launcher" >&2
  return 1
}

activate() {
  launcher_available
  mkdir -p "$bin_dir"
  if [ ! -e "$launcher" ] && [ ! -L "$launcher" ]; then
    ln -s "$install_dir/pi-wait-for-user" "$launcher"
  fi
}

case "$action" in
  install)
    verify_directory "$payload_dir"
    launcher_available
    if [ -e "$install_dir" ]; then
      echo "pi-wait-for-user: install already exists: $install_dir" >&2
      exit 1
    fi
    parent=$(dirname "$install_dir")
    temporary="$parent/.${release_id}.tmp.$$"
    mkdir -p "$parent"
    rm -rf "$temporary"
    mkdir "$temporary"
    trap 'rm -rf "$temporary"' EXIT HUP INT TERM
    cp -R "$payload_dir/." "$temporary/"
    mv "$temporary" "$install_dir"
    trap - EXIT HUP INT TERM
    activate
    verify_directory "$install_dir"
    "$install_dir/pi-wait-for-user" conformance
    echo "Installed $release_id."
    echo "Command: $launcher"
    case ":${PATH:-}:" in
      *":$bin_dir:"*) echo "Run: pi-wait-for-user" ;;
      *) echo "Add $bin_dir to PATH, then run: pi-wait-for-user" ;;
    esac
    echo "Your existing pi command and ~/.pi data were not modified."
    ;;
  verify)
    verify_directory "$install_dir"
    echo "Verified $release_id."
    ;;
  activate)
    verify_directory "$install_dir"
    activate
    echo "Activated $release_id."
    ;;
  uninstall)
    test -d "$install_dir" || { echo "pi-wait-for-user: no installation at $install_dir" >&2; exit 1; }
    if [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$install_dir/pi-wait-for-user" ]; then
      rm "$launcher"
    fi
    rm -rf "$install_dir"
    echo "Removed $release_id. Pi settings and sessions were left unchanged."
    ;;
  *)
    echo "$usage" >&2
    exit 1
    ;;
esac
