# Pi Wait for User · `pi-v0.81.1-patch.11`

End-to-end Managed Installation release for macOS Apple Silicon and Linux ARM64/x64.

## What changed

- The production receipt projection is one executable metadata CLI boundary that resolves generated Release Manifest paths correctly and emits exactly the supported macOS Apple Silicon and Linux ARM64/x64 receipts.
- Before protected Environment approval can be requested, the no-secret release candidate signs with public fixture authority, exercises that same receipt boundary with workspace-relative and absolute paths, proves missing and malformed inputs fail closed, records exact output inventory, uploads a machine-readable report, and writes a concise workflow summary.
- The reviewed HTTPS bootstrap pins the production root public key, verifies root-signed trust metadata and the delegated signatures on the Release Channel and Release Manifest, then downloads only the exact signed Manager Release and platform Downstream Release artifacts.
- Plain bootstrap remains side-by-side; `--manage-pi` explicitly enables Command Ownership while preserving Stock Pi and shared Pi settings, credentials, packages, sessions, and Agent Threads.
- The release workflow smoke-tests macOS Apple Silicon plus Linux ARM64/x64 payloads and requires the complete lifecycle/state-machine suite, metadata projections, provenance, and public conformance before publication.
- Intel macOS is rejected as unsupported, is not built, and has no archive, descriptor, receipt, checksum, or provenance subject in this release.
- Strict model hydration no longer requires eight OpenAI API models shut down on 2026-07-23 or their derived Azure catalog entries; all other committed model identities remain release-gated against the live catalogs.
- Managed status, Managed Update, Patch Lag, rollback, recovery, disablement, Stock Pi execution, verification, retention, and uninstall are documented and release-gated.

## Install

Side-by-side:

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.11/install.sh | sh
```

Explicit Managed Installation:

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.11/install.sh | sh -s -- --manage-pi
```

The HTTPS-fetched script is the initial trust event; use the checksum/attestation-first instructions in the README for an independently checked first use.

## Verification

The attached `release-candidate.json` is the complete required-gate result. Candidate evidence also preserves `.release-metadata/production-receipt-preflight.json`. `artifact-manifest.json` and `SHA256SUMS` are generated from the signed Release Manifest. GitHub build-provenance attestations bind every published release asset to the release workflow and exact source commit.

## Durability boundary

This release guarantees reconstruction after completed session-journal appends and process teardown. It does not add `fsync`, power-loss safety, torn-tail repair, exact-once external tool side effects, or exact-once provider invocation.

## Archive

The failed `pi-v0.81.1-patch.9` and `pi-v0.81.1-patch.10` publication candidates have immutable public tags but no GitHub Releases. Those tags are never moved, deleted, or reused; this release uses the new `pi-v0.81.1-patch.11` identity.
