# Downstream release metadata

The signed **Release Channel** is the sole mutable promotion authority. It has a monotonic sequence and selects one complete, signed, immutable **Release Manifest** by release ID, URL, and SHA-256. `releases/active.json` is no longer stored or read as an independent pointer.

During compatibility migration, `release-metadata.mjs promote` may generate an `active.json` projection. That file carries `generatedFrom: "release-channel"`, the Channel sequence, and manifest digest. Consumers must verify the Channel and manifest before using the projection.

The checked-in `releases/<release-id>/manifest.json` is a **release candidate input**, not an active Channel selection or the published Release Manifest. The package version identifies that candidate (`pi-v${package.version}`), and verification requires every package, shell, installer, and documentation identity to agree. A published `release-manifest.json` is produced only after artifacts and GitHub provenance have been verified.

## Metadata schemas

Versioned JSON Schemas live in [`schemas`](schemas):

- `release-trust-v1.schema.json`: root-signed delegation of expiring/revocable Ed25519 release keys and the authenticated Channel URL;
- `release-channel-v1.schema.json`: expiring, monotonic selection of one manifest; and
- `release-manifest-v1.schema.json`: exact source, patches, compatibility, the exact Question Tool package, actual Manager Release artifacts, bootstrap installer, gate definitions/reports, archives, extracted payload inventory, provenance, and notes.

Runtime validators in `scripts/lib/release-metadata.mjs` reject unknown schemas, extra/missing fields, malformed values, invalid or unauthorized signatures, expired/revoked keys, expired metadata, digest drift, incomplete payload inventories, file-mode drift, replay, and provenance mismatch. Packaging and extracted-payload verification call the same filesystem inventory primitive, including path normalization, symlink, file-kind, digest, size, and mode rules.

The local consumer of these identities is documented in [`docs/release/managed-runtime.md`](../docs/release/managed-runtime.md). The release package projects `manager.releaseId` and compatible manifest versions into `package.json`; its `manager` executable is the immutable Manager Release entrypoint selected by stage 0.

## Build and promotion

1. Create a new release ID and immutable input directory; never edit an already published release.
2. Pin the exact upstream lock, ordered patch hashes, fixture gate, Question Tool/session/protocol/handler compatibility, Manager Release compatibility, and provenance identity.
3. Set the package version to the downstream version. Generate or check shell/package identity with `node scripts/release.mjs verify`.
4. Run `npm test` and `node scripts/release-gate.mjs` from a clean checkout.
5. Build archives with `scripts/package-binaries.mjs`. Each archive receives a sidecar inventory containing every extracted file's digest, size, and mode.
6. Run `node scripts/release.mjs bundle dist/<release-id> <binary-directory>`. This stages immutable payloads plus `.release-metadata/unsigned-manifest.json` and a provenance request. It does **not** claim the manifest is signed.
7. Attest and verify every payload with `gh attestation verify`, requiring this repository, `.github/workflows/release.yml`, and the exact source commit.
8. Run `release-metadata.mjs sign-manifest` with the verified provenance result and an authorized release key.
9. Run `release-metadata.mjs promote` with a higher Channel sequence. It verifies trust, signatures, manifest digest, and both replay checkpoints, then generates `trust-state.json`, `channel-state.json`, the Channel, `artifact-manifest.json`, `SHA256SUMS`, archive metadata, and temporary `active.json` compatibility projection. Generate installation receipts from the verified manifest with `release-metadata.mjs receipt`.
10. Attest and verify every publishable artifact before creating the immutable GitHub release. Publish the stable Channel only after its selected manifest and payloads are available.

Production private keys are provisioned by the human-controlled key ceremony, never committed. See [`docs/release/signing-keys.md`](../docs/release/signing-keys.md).

## Replay and retries

Accepted trust state stores the highest root-signed trust version and SHA-256 of the canonical complete trust envelope. A lower trust version is replay; an equal version is accepted only when the canonical envelope digest is identical. This prevents an older still-unexpired delegation from restoring a revoked or rotated release key.

Accepted Channel state stores the highest sequence, selected release ID and manifest digest, and SHA-256 of the canonical complete Channel envelope. A lower sequence is replay. At an equal sequence, any change—including expiry, manifest URL, or signatures—is rejected; only the identical canonical envelope is an idempotent retry. Every new selection—including `patch.5` to `patch.6` on the same upstream Pi version—uses a higher sequence. These generated checkpoints are anti-replay state, not release-selection authorities.

## Archive policy

Promotion never edits or deletes a previous release directory, tag, signed manifest, report, checksum projection, provenance attestation, or payload. Archived releases remain downloadable and reproducible for their pinned source but receive no fixes, rebases, or feature updates.
