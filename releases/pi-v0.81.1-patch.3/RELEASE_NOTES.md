# Pi Wait for User · `pi-v0.81.1-patch.3`

Question Tool keyboard-navigation fix for durable human interactivity in Pi.

## What changed

- Question Tool `0.1.2` lets Up Arrow leave inline custom-answer editing and return to the preceding supplied choice
- The custom draft remains available when leaving custom editing
- Existing Escape, Tab, submission, and durable-response behavior is unchanged
- Fast, checksummed precompiled binaries remain available for macOS, Linux, and Windows on ARM64 and x64

## Install

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.3/install.sh | sh
```

The installer selects and verifies the current platform asset, installs a separate `pi-wait-for-user` command, and leaves upstream Pi plus `~/.pi/agent` data unchanged.

## Verification

The attached `release-candidate.json` is the complete required-gate result. `artifact-manifest.json` and `SHA256SUMS` identify every downloadable source, binary, package, and report asset. GitHub's build-provenance attestation ties those assets to the release workflow.

## Durability boundary

This release guarantees reconstruction after completed session-journal appends and process teardown. It does not add `fsync`, power-loss safety, torn-tail repair, exact-once external tool side effects, or exact-once provider invocation.

## Archive

[`pi-v0.81.1-patch.2`](https://github.com/taylorrowser/pi-wait-for-user/releases/tag/pi-v0.81.1-patch.2) is archived unchanged and remains downloadable. Archived releases receive no retroactive changes.
