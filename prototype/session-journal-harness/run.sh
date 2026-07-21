#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if (($# == 0)); then
  PI_BIN="$(command -v pi)"
  PI_CLI="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$PI_BIN")"
  set -- "$(cd "$(dirname "$PI_CLI")/.." && pwd)"
fi

for package_root in "$@"; do
  node "$HERE/harness.mjs" "$package_root"
done
