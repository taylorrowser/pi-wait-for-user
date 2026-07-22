#!/bin/sh
set -eu

release_id="pi-v0.81.1-patch.4"
repository="taylorrowser/pi-wait-for-user"
base_url="https://github.com/${repository}/releases/download/${release_id}"

for command in curl tar uname; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "pi-wait-for-user: required command not found: $command" >&2
    exit 1
  fi
done

if [ -n "${PI_WAIT_FOR_USER_PLATFORM:-}" ]; then
  platform=$PI_WAIT_FOR_USER_PLATFORM
else
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) echo "pi-wait-for-user: prebuilt installation supports macOS and Linux" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) echo "pi-wait-for-user: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  platform="$os-$arch"
fi

case "$platform" in
  darwin-arm64|darwin-x64|linux-arm64|linux-x64) ;;
  *) echo "pi-wait-for-user: unsupported binary platform: $platform" >&2; exit 1 ;;
esac

asset="pi-wait-for-user-${platform}.tar.gz"
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
exec sh "$temporary/pi-wait-for-user/install.sh" "$action" "$@"
