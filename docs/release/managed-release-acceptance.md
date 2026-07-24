# Managed Installation release acceptance

This is the release-level traceability record for GitHub issues #63 and #80 and the accepted [Managed Installation design](../design/managed-installation.md). Observable behavior is tested at the filesystem/CLI, signed-metadata, release-bundle, and workflow boundaries; private helpers are not acceptance seams.

## Release and bootstrap

| Design / #63 requirement | Automated evidence |
| --- | --- |
| Signed trust, Channel, Release Manifest, exact Manager Release, Question Tool, platform Downstream Release payloads, generated projections, receipts, and provenance | `test/release-metadata.test.mjs` — “authorized root and release signatures verify complete metadata”, “manifest projections are generated from one verified identity”, “production signing is tag-only…”, and provenance/drift rejection; `test/release.test.mjs` — “a passing release stages complete artifacts while omitting Intel macOS”; `.github/workflows/release.yml` generates `installation-receipt-<platform>.json` for `darwin-arm64`, `linux-arm64`, and `linux-x64` before attesting and publishing every top-level asset |
| Clean HTTPS side-by-side or explicit Command Ownership bootstrap | `test/binary-release.test.mjs` — managed bootstrap authority and signed-descriptor tests; `test/managed-runtime.test.mjs` — “installer claims pi only with explicit --manage-pi” and “plain side-by-side setup…” |
| Independently checked first use | `README.md` “Independently checked first use”; workflow attestation of `install.sh`; root SPKI fixture/production fingerprint verification in `test/release-metadata.test.mjs` |
| macOS Apple Silicon and Linux ARM64/x64 smoke and public conformance | `.github/workflows/release.yml` `platform-smoke` matrix; release-candidate Linux interactive Question Tool smoke |
| Release CI fails on state-machine, drift, provenance, platform smoke, or conformance failure | `scripts/release-gate.mjs` repository tests and public-conformance stages; metadata mutation tests; required `platform-smoke` matrix; `production-release` depends on both |

## Installation, update, and compatibility

| Design / #63 scenario | Automated evidence in `test/managed-runtime.test.mjs` |
| --- | --- |
| Fresh install with/without Stock Pi and package/version-manager paths | “installer claims pi only with explicit --manage-pi”, “managed enable records Stock Pi…”, and npm/pnpm/Bun/mise path matrix |
| Losing/winning PATH, collisions, disable/re-enable, legacy migration | PATH, collision, interruption, side-by-side, disable/re-enable, and both Legacy Downstream Installation tests |
| Real synthetic patch-only transition with unchanged upstream | “signed Channel sequence and Downstream Release identity detect every compatible pair change” and “a patch-only Activation reuses one exact immutable Manager Release” |
| Compatible upstream rebase, Manager-only, and Question Tool change | same signed pair-change matrix and Managed Update download/activation test |
| Patch Lag and informational upstream outage | “Patch Lag is a successful no-op…” plus SemVer ordering test |
| Signature, digest, identity, schema, platform, smoke, and conformance failure | metadata failure tests; candidate verification matrix; reported identity/smoke/conformance boundary test; incompatible-platform startup test |
| Status and compatibility explanations | “managed status reports pair compatibility, Stock Pi, Channel, Patch Lag, and Update Hold” and Stock Pi divergence test |
| Stock and rollback session-boundary warnings | CLI rollback and `managed stock` tests; `scripts/managed-manager.mjs` observable warning text |
| Update routing and output isolation | Dispatcher self-update exclusion, `--all` partial result, startup cache/throttle, and TTY/JSON/RPC isolation tests |

## Atomic lifecycle and cleanup

| Design / #63 scenario | Automated evidence in `test/managed-runtime.test.mjs` |
| --- | --- |
| Complete old or new Activation across publication/switch boundaries | “every publish/switch interruption…” and “Managed Update preserves the old or complete new pair at every updater activation boundary” |
| Rollback, Update Hold, retry, and later release visibility | rollback/hold/unhold tests, successful reactivation hold-clear matrix, and explicit CLI output test |
| Active/previous/pinned/live-leased retention | retention, lease deferral, cleanup race, tombstone, and convergent retry tests |
| Corrupt-active fail-closed recovery | malformed/tampered launch test and stage-0 previous recovery test |
| Receipt-safe uninstall and preservation | uninstall, every interruption boundary, forged/symlink state refusal, leased deferral, absent no-op, and shared-data preservation hash tests |

## Intel macOS removal (#80)

| #80 requirement | Automated evidence |
| --- | --- |
| Intel macOS is not built and the public release inventory omits its archives, descriptors, checksums, and provenance subjects | `test/release-metadata.test.mjs` verifies the workflow's post-build Intel-archive absence guard; `test/release.test.mjs` — “a passing release stages complete artifacts while omitting Intel macOS”; `test/binary-release.test.mjs` — “the binary packager rejects the retired Intel macOS target” |
| Managed HTTPS bootstrap rejects Intel macOS before selection or download | `test/binary-release.test.mjs` — “the managed HTTPS bootstrap rejects Intel macOS before any download” |
| Production smoke and receipt outputs contain only supported managed targets | `test/release-metadata.test.mjs` — exact `darwin-arm64`, `linux-arm64`, and `linux-x64` workflow matrix plus receipt filter |

## Documentation and scope

`README.md` documents installation, Managed Update, Patch Lag, verification, provenance audit, rollback, recovery, disablement, Stock Pi, uninstall, Legacy Downstream Installation guidance, key rotation/compromise boundaries, Windows manual scope, and unmanaged source-build fallback. Detailed command and state semantics remain in [`managed-runtime.md`](managed-runtime.md); public signing and key rotation are in [`signing-keys.md`](signing-keys.md) and [`production-signing-runbook.md`](production-signing-runbook.md).

The release candidate remains unpublished until the protected workflow signs it with the human-provisioned delegated key. No production private signing material is created or handled by this acceptance gate.
