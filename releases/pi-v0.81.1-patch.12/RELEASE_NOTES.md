# Pi Wait for User · `pi-v0.81.1-patch.12`

Managed Installation release for macOS Apple Silicon, Linux ARM64/x64, and Windows ARM64/x64.

## What changed

- Windows x64 and ARM64 payloads now embed a reviewed PowerShell bootstrap that verifies the production root/delegated trust chain, signed Channel, Release Manifest, exact Manager Release, and exact Windows Downstream Release before Activation.
- Explicit `-ManagePi` Command Ownership uses receipt-owned `pi.cmd` and `pi-wait-for-user.cmd` entrypoints without requiring symlink privileges or editing PATH.
- Windows enablement refuses foreign extensionless, `.com`, `.exe`, `.bat`, `.cmd`, `.ps1`, PowerShell alias, function, and cmdlet collisions; Stock Pi is recorded and left untouched.
- Manager Release `manager-v3` adds Windows-native data roots, process identities, exclusive lifecycle locking, pair leases, atomic Activation replacement, executable-lock deferral, and receipt-safe cleanup.
- Patch-aware update, Patch Lag, verification, rollback, holds, recovery, retention, disablement, and uninstall use the same signed cross-platform state machines.
- Cleanup never force-deletes or schedules foreign paths for deletion. Live leases and Windows executable locks remain receipt-scoped pending cleanup for a later lifecycle pass.
- Native Windows x64 CI covers fresh side-by-side/managed installation, PATH and launcher collisions, Stock Pi preservation, patch-only Activation, interruption, rollback, leases, corrupt-active recovery, and uninstall. Signed Windows ARM64 packaging and receipt projections remain gated where GitHub-hosted native ARM64 runners are unavailable.
- `ModelRegistry.refresh()` reloads local `models.json` data without coupling config refresh to a remote model-catalog request, preventing suite/load-sensitive stalls while preserving built-in/custom model merging.
- `%USERPROFILE%\.pi\agent`, configured Pi data, Stock Pi, sessions, settings, credentials, and packages remain outside manager ownership.

## Install

Follow the attestation-first Windows, macOS, or Linux instructions in the README. macOS/Linux bootstrap URLs use:

```text
https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.12/install.sh
```

The Windows `install.ps1` is embedded in each signed Windows archive and is itself covered by that archive's signed payload inventory and GitHub provenance.

## Verification

The attached `release-candidate.json` is the complete required-gate result. `artifact-manifest.json`, `SHA256SUMS`, archive metadata, and all five managed installation receipts are generated from the signed Release Manifest. GitHub build-provenance attestations bind every published release asset to the release workflow and exact source commit.

## Durability boundary

This release guarantees reconstruction after completed session-journal appends and process teardown. It does not add `fsync`, power-loss safety, torn-tail repair, exact-once external tool side effects, or exact-once provider invocation.

## Archive

`pi-v0.81.1-patch.11` remains immutable and archived after this candidate is published. Earlier failed publication tags are never moved, deleted, or reused.
