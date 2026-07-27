# Pi Wait for User · `pi-v0.81.1-patch.14`

Managed Installation maintenance release for macOS Apple Silicon, Linux ARM64/x64, and Windows ARM64/x64.

## What changed

- Question Tool `0.1.5` preserves a retained custom-answer draft when Backspace or Delete first enters editing from the selected custom row.
- After editing is active, a subsequent Backspace or Delete edits normally.
- DEL and C1 control bytes are no longer classified as printable edit-entry input.
- Regression coverage exercises the complete two-step Backspace/Delete behavior through the public Question Form component.
- All patch.13 Managed Installation, signed Channel, Windows lifecycle, model-catalog, durable-deferral, and conformance guarantees remain unchanged.
- `%USERPROFILE%\.pi\agent`, configured Pi data, Stock Pi, sessions, settings, credentials, and packages remain outside manager ownership.

## Install

Follow the attestation-first Windows, macOS, or Linux instructions in the README. macOS/Linux bootstrap URLs use:

```text
https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.14/install.sh
```

The Windows `install.ps1` is embedded in each signed Windows archive and is itself covered by that archive's signed payload inventory and GitHub provenance.

## Verification

The attached `release-candidate.json` is the complete required-gate result. `artifact-manifest.json`, `SHA256SUMS`, archive metadata, and all five managed installation receipts are generated from the signed Release Manifest. GitHub build-provenance attestations bind every published release asset to the release workflow and exact source commit.

## Durability boundary

This release guarantees reconstruction after completed session-journal appends and process teardown. It does not add `fsync`, power-loss safety, torn-tail repair, exact-once external tool side effects, or exact-once provider invocation.

## Archive

`pi-v0.81.1-patch.13` remains an immutable archived release after patch.14 promotion. Failed public tags `pi-v0.81.1-patch.9`, `.10`, and `.12` remain unchanged and are never deleted, moved, reused, or rerun.
