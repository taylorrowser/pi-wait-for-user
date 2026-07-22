# Downstream releases

`active.json` is the only mutable pointer. Every sibling release directory is an immutable identity record for one exact upstream Pi target and one independently versioned Question Tool.

## Promote a release

1. Create a **new** release ID and directory; never copy over an existing one.
2. Pin the upstream lock, ordered patch hashes, fixture gate, and package compatibility in its manifest. Any intentional journal or deferred-semantics change must also record an explicit session/protocol compatibility decision and update its fixture.
3. Update package/bootstrap versions and installation documentation.
4. Point `active.json` at the new ID.
5. Run `npm test` and `node scripts/release-gate.mjs` from a clean checkout.
6. Build the assets with `node scripts/release.mjs bundle dist/<release-id>`.
7. Merge, create the exact manifest tag, and let `.github/workflows/release.yml` repeat the gate and publish.
8. Enable GitHub immutable releases in repository settings.

The workflow refuses a tag that differs from `active.json` and refuses to replace an existing GitHub release.

## Archive policy

Promotion does not edit or delete the previous directory, tag, report, checksum file, provenance attestation, or assets. A previous release remains downloadable and reproducible for its pinned Pi source but receives no fixes, rebases, or feature updates. Only the release selected by `active.json` is supported.
