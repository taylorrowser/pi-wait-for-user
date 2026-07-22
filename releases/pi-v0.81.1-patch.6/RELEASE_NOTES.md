# Pi Wait for User · `pi-v0.81.1-patch.6`

Session-format compatibility clarification for persisted downstream sessions.

## What changed

- `session-format.md` now states that every new persisted session created by this downstream eagerly receives the fail-closed `dev.taylorrowser.pi-wait-for-user/session` header before its first append
- The documentation explicitly records the compatibility tradeoff: Stock Pi cannot open these sessions even when they contain only ordinary prompts and responses
- Already-flushed Stock Pi sessions retain their upstream header and remain readable by Stock Pi, but cannot enable durable deferral
- A regression test runs an ordinary prompt and response without deferring, then verifies the downstream header and absence of a Deferred Tool Batch marker
- Runtime behavior, Question Tool `0.1.3`, the durable-deferral protocol, and the package schema remain unchanged
- Fast, checksummed precompiled binaries remain available for macOS, Linux, and Windows on ARM64 and x64

## Install

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.6/install.sh | sh
```

The installer selects and verifies the current platform asset, installs a separate `pi-wait-for-user` command, and leaves Stock Pi plus `~/.pi/agent` data unchanged.

## Verification

The attached `release-candidate.json` is the complete required-gate result. `artifact-manifest.json` and `SHA256SUMS` identify every downloadable source, binary, package, and report asset. GitHub's build-provenance attestation ties those assets to the release workflow.

## Durability boundary

This release guarantees reconstruction after completed session-journal appends and process teardown. It does not add `fsync`, power-loss safety, torn-tail repair, exact-once external tool side effects, or exact-once provider invocation.

## Archive

[`pi-v0.81.1-patch.5`](https://github.com/taylorrowser/pi-wait-for-user/releases/tag/pi-v0.81.1-patch.5) is archived unchanged and remains downloadable. Archived releases receive no retroactive changes.
