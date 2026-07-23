# Pi Wait for User · `pi-v0.81.1-patch.7`

Core-owned deferred-work re-entry with package-customizable presentation.

## What changed

- Pi core now renders and clears one persistent deferred-work affordance from active `session.deferredBatch` state
- `/deferred` opens a compatible package presenter and falls back to the generic inspector
- `/deferred inspect` always opens the generic Retry/Abandon/Close recovery interface
- Escape from full deferred UI restores package-provided privacy-safe text or a generic core summary
- Missing, unavailable, and throwing package presentation fails open to core UI
- The extension deferral API adds an optional read-only `summary` callback; core retains mounting, command routing, recovery, and cleanup ownership
- Question Tool `0.1.4` supplies privacy-safe question-count text and no longer manages a deferred widget lifecycle
- Regression coverage includes presentation selection, command routing, dismissal, clearing, failures, and consecutive Deferred Tool Batches
- Fast, checksummed precompiled binaries remain available for macOS, Linux, and Windows on ARM64 and x64

## Install

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.7/install.sh | sh
```

The installer selects and verifies the current platform asset, installs a separate `pi-wait-for-user` command, and leaves Stock Pi plus `~/.pi/agent` data unchanged.

## Verification

The attached `release-candidate.json` is the complete required-gate result. `artifact-manifest.json` and `SHA256SUMS` identify every downloadable source, binary, package, and report asset. GitHub's build-provenance attestation ties those assets to the release workflow.

## Durability boundary

This release guarantees reconstruction after completed session-journal appends and process teardown. It does not add `fsync`, power-loss safety, torn-tail repair, exact-once external tool side effects, or exact-once provider invocation.

## Archive

[`pi-v0.81.1-patch.6`](https://github.com/taylorrowser/pi-wait-for-user/releases/tag/pi-v0.81.1-patch.6) is archived unchanged and remains downloadable. Archived releases receive no retroactive changes.
