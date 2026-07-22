# Pi Wait for User · `pi-v0.81.1-patch.5`

Restart reconstruction fix for the reference durable-deferral extension in Pi.

## What changed

- The shipped `durable-deferral.ts` example now reconstructs its active Interaction Request from the current presenter context after complete process teardown
- Relaunching a deferred Agent Thread opens the package presenter instead of reporting `No active durable wait request` and falling back to the generic inspector
- A regression test creates a durable wait, tears down the original extension instance, reopens the persisted session with a fresh instance, and invokes the registered presenter
- Question Tool `0.1.3`, the durable-deferral protocol, and the package schema remain unchanged
- Fast, checksummed precompiled binaries remain available for macOS, Linux, and Windows on ARM64 and x64

## Install

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.5/install.sh | sh
```

The installer selects and verifies the current platform asset, installs a separate `pi-wait-for-user` command, and leaves upstream Pi plus `~/.pi/agent` data unchanged.

## Verification

The attached `release-candidate.json` is the complete required-gate result. `artifact-manifest.json` and `SHA256SUMS` identify every downloadable source, binary, package, and report asset. GitHub's build-provenance attestation ties those assets to the release workflow.

## Durability boundary

This release guarantees reconstruction after completed session-journal appends and process teardown. It does not add `fsync`, power-loss safety, torn-tail repair, exact-once external tool side effects, or exact-once provider invocation.

## Archive

[`pi-v0.81.1-patch.4`](https://github.com/taylorrowser/pi-wait-for-user/releases/tag/pi-v0.81.1-patch.4) is archived unchanged and remains downloadable. Archived releases receive no retroactive changes.
