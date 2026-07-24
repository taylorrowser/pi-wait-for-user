# Pi Wait for User · `pi-v0.81.1-patch.9`

First end-to-end Managed Installation release for supported macOS and Linux platforms.

## What changed

- The reviewed HTTPS bootstrap pins the production root public key, verifies root-signed trust metadata and the delegated signatures on the Release Channel and Release Manifest, then downloads only the exact signed Manager Release and platform Downstream Release artifacts.
- Plain bootstrap remains side-by-side; `--manage-pi` explicitly enables Command Ownership while preserving Stock Pi and shared Pi settings, credentials, packages, sessions, and Agent Threads.
- The release workflow smoke-tests macOS/Linux ARM64 and x64 payloads and requires the complete lifecycle/state-machine suite, metadata projections, provenance, and public conformance before publication.
- Managed status, Managed Update, Patch Lag, rollback, recovery, disablement, Stock Pi execution, verification, retention, and uninstall are documented and release-gated.

## Install

Side-by-side:

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.9/install.sh | sh
```

Explicit Managed Installation:

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.9/install.sh | sh -s -- --manage-pi
```

The HTTPS-fetched script is the initial trust event; use the checksum/attestation-first instructions in the README for an independently checked first use.

## Verification

The attached `release-candidate.json` is the complete required-gate result. `artifact-manifest.json` and `SHA256SUMS` are generated from the signed Release Manifest. GitHub build-provenance attestations bind every release asset to the release workflow and exact source commit.

## Durability boundary

This release guarantees reconstruction after completed session-journal appends and process teardown. It does not add `fsync`, power-loss safety, torn-tail repair, exact-once external tool side effects, or exact-once provider invocation.

## Archive

[`pi-v0.81.1-patch.8`](https://github.com/taylorrowser/pi-wait-for-user/releases/tag/pi-v0.81.1-patch.8) is archived unchanged and remains downloadable. Archived releases receive no retroactive changes.
