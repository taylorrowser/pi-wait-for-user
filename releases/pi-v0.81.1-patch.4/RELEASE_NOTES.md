# Pi Wait for User · `pi-v0.81.1-patch.4`

Fail-closed resolver fix for durable human interactivity in Pi.

## What changed

- A well-formed `unavailable` result from a live tool-deferral resolver now raises the typed `resolver_error`
- Live resolver unavailability no longer appends a synthetic assistant failure after an unresolved tool-call batch
- The session file remains byte-identical after the resolver failure boundary
- Question Tool `0.1.3` preserves answers submitted from custom input and scopes restored outcomes to the active request identity
- Existing malformed, thrown, aborted, recovery, and abandonment behavior is unchanged
- Fast, checksummed precompiled binaries remain available for macOS, Linux, and Windows on ARM64 and x64

## Install

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.4/install.sh | sh
```

The installer selects and verifies the current platform asset, installs a separate `pi-wait-for-user` command, and leaves upstream Pi plus `~/.pi/agent` data unchanged.

## Verification

The attached `release-candidate.json` is the complete required-gate result. `artifact-manifest.json` and `SHA256SUMS` identify every downloadable source, binary, package, and report asset. GitHub's build-provenance attestation ties those assets to the release workflow.

## Durability boundary

This release guarantees reconstruction after completed session-journal appends and process teardown. It does not add `fsync`, power-loss safety, torn-tail repair, exact-once external tool side effects, or exact-once provider invocation.

## Archive

[`pi-v0.81.1-patch.3`](https://github.com/taylorrowser/pi-wait-for-user/releases/tag/pi-v0.81.1-patch.3) is archived unchanged and remains downloadable. Archived releases receive no retroactive changes.
