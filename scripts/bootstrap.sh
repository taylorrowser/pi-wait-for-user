#!/bin/sh
set -eu

release_id="pi-v0.81.1-patch.1"
repository="taylorrowser/pi-wait-for-user"
asset="pi-wait-for-user-${release_id}.tgz"
base_url="https://github.com/${repository}/releases/download/${release_id}"

for command in node npm git curl tar; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "pi-wait-for-user: required command not found: $command" >&2
    exit 1
  fi
done

major=$(node -p 'process.versions.node.split(".")[0]')
minor=$(node -p 'process.versions.node.split(".")[1]')
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 19 ]; }; then
  echo "pi-wait-for-user: Node.js 22.19 or newer is required" >&2
  exit 1
fi

temporary=$(mktemp -d "${TMPDIR:-/tmp}/pi-wait-for-user.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

curl -fL --retry 3 -o "$temporary/$asset" "$base_url/$asset"
curl -fL --retry 3 -o "$temporary/SHA256SUMS" "$base_url/SHA256SUMS"
expected=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$temporary/SHA256SUMS")
if [ -z "$expected" ]; then
  echo "pi-wait-for-user: release checksum is missing for $asset" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/$asset" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$temporary/$asset" | awk '{ print $1 }')
fi
if [ "$actual" != "$expected" ]; then
  echo "pi-wait-for-user: release checksum mismatch" >&2
  exit 1
fi

tar -xzf "$temporary/$asset" -C "$temporary"
action=${1:-install}
if [ "$#" -gt 0 ]; then shift; fi
exec node "$temporary/package/scripts/install.mjs" "$action" "$@"
