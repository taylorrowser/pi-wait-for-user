# Pi Wait for User · `pi-v0.81.1-patch.1`

First maintained downstream release of durable human interactivity for Pi.

## Included

- Exact upstream Pi `v0.81.1` at `20be4b18d4c57487f8993d2762bace129f0cf7c6`
- Ten ordered durable Deferred Tool Batch patches
- `@taylorrowser/pi-question-tool@0.1.0`
- Public `pi conformance` command
- SDK, extension, RPC, JSON, print, and TUI deferred-state support
- Crash-boundary recovery, unavailable-state abandonment, branch handling, queue ordering, and compaction pinning

## Install

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.1/install.sh | sh
```

The installer creates the separate `pi-wait-for-user` command without replacing an existing upstream `pi` command. See the bundled or repository README for checksum-first installation, verification, rollback, and uninstall instructions.

## Verification

The attached `release-candidate.json` is the complete required-gate result. `artifact-manifest.json` and `SHA256SUMS` identify every downloadable asset. GitHub's build-provenance attestation independently ties assets to the release workflow.

## Durability boundary

This release guarantees reconstruction after completed session-journal appends and process teardown. It does not add `fsync`, power-loss safety, torn-tail repair, exact-once external tool side effects, or exact-once provider invocation.

## Support policy

This is the one active target. When superseded, it becomes an immutable archived release: still downloadable for this exact Pi version, but no longer rebased, updated, or retroactively fixed.
