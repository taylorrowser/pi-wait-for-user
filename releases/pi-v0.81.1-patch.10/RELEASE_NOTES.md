# Pi Wait for User · `pi-v0.81.1-patch.10`

End-to-end Managed Installation release for macOS Apple Silicon and Linux ARM64/x64.

## What changed

- The reviewed HTTPS bootstrap pins the production root public key, verifies root-signed trust metadata and the delegated signatures on the Release Channel and Release Manifest, then downloads only the exact signed Manager Release and platform Downstream Release artifacts.
- Plain bootstrap remains side-by-side; `--manage-pi` explicitly enables Command Ownership while preserving Stock Pi and shared Pi settings, credentials, packages, sessions, and Agent Threads.
- The release workflow smoke-tests macOS Apple Silicon plus Linux ARM64/x64 payloads and requires the complete lifecycle/state-machine suite, metadata projections, provenance, and public conformance before publication.
- Intel macOS is rejected as unsupported and has no archive, descriptor, receipt, checksum, or provenance subject in this release.
- Strict model hydration no longer requires eight OpenAI API models shut down on 2026-07-23 or their derived Azure catalog entries; all other committed model identities remain release-gated against the live catalogs.
- Managed status, Managed Update, Patch Lag, rollback, recovery, disablement, Stock Pi execution, verification, retention, and uninstall are documented and release-gated.

## Install

Side-by-side:

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.10/install.sh | sh
```

Explicit Managed Installation:

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.10/install.sh | sh -s -- --manage-pi
```

The HTTPS-fetched script is the initial trust event; use the checksum/attestation-first instructions in the README for an independently checked first use.

## Verification

The attached `release-candidate.json` is the complete required-gate result. `artifact-manifest.json` and `SHA256SUMS` are generated from the signed Release Manifest. GitHub build-provenance attestations bind every release asset to the release workflow and exact source commit.

## Durability boundary

This release guarantees reconstruction after completed session-journal appends and process teardown. It does not add `fsync`, power-loss safety, torn-tail repair, exact-once external tool side effects, or exact-once provider invocation.

## Archive

[`pi-v0.81.1-patch.9`](https://github.com/taylorrowser/pi-wait-for-user/releases/tag/pi-v0.81.1-patch.9) is archived unchanged and its public tag is never moved or reused. Archived releases receive no retroactive changes.
