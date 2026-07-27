# Managed Installation release acceptance

This is the release-level traceability record for GitHub issues #63, #64, #80, #82, #87, #89, and #91 and the accepted [Managed Installation design](../design/managed-installation.md). Observable behavior is tested at the filesystem/CLI, signed-metadata, release-bundle, and workflow boundaries; private helpers are not acceptance seams.

## Release and bootstrap

| Design / #63 requirement | Automated evidence |
| --- | --- |
| Signed trust, Channel, Release Manifest, exact Manager Release, Question Tool, platform Downstream Release payloads, generated projections, receipts, and provenance | `test/release-metadata.test.mjs` — “authorized root and release signatures verify complete metadata”, “manifest projections are generated from one verified identity”, “production signing is tag-only…”, and provenance/drift rejection; `test/release-receipts.test.mjs` executes the shared production/preflight CLI boundary for relative/absolute paths, exact supported inventory, unsupported Intel, and missing/malformed input; `test/release.test.mjs` — “a passing release stages complete artifacts while omitting Intel macOS”; `.github/workflows/release.yml` preserves the fixture-authority preflight report before the protected dependency and later generates `installation-receipt-<platform>.json` for `darwin-arm64`, `linux-arm64`, `linux-x64`, `windows-arm64`, and `windows-x64` before attesting and publishing every top-level asset |
| Clean HTTPS side-by-side or explicit Command Ownership bootstrap | `test/binary-release.test.mjs` — managed bootstrap authority and signed-descriptor tests; `test/managed-runtime.test.mjs` — “installer claims pi only with explicit --manage-pi” and “plain side-by-side setup…” |
| Independently checked first use | `README.md` “Independently checked first use”; workflow attestation of `install.sh`; root SPKI fixture/production fingerprint verification in `test/release-metadata.test.mjs` |
| macOS Apple Silicon and Linux ARM64/x64 smoke and public conformance | `.github/workflows/release.yml` `platform-smoke` matrix; release-candidate Linux interactive Question Tool smoke |
| Release CI fails on state-machine, drift, provenance, platform smoke, or conformance failure | `scripts/release-gate.mjs` repository tests and public-conformance stages; metadata mutation tests; required `platform-smoke` matrix; `production-release` depends on both |

## Production receipt preflight and hydration prerequisite (#82)

| #82 requirement | Automated evidence |
| --- | --- |
| Workspace-relative and absolute generated Release Manifest paths load through one production/preflight receipt boundary | `test/release-receipts.test.mjs` executes `release-metadata.mjs receipts` with both path forms and verifies the exact supported receipt inventory |
| Unprotected no-secret preflight runs before protected production signing, emits machine-readable evidence and a workflow summary, and fails closed for missing/malformed inputs | `test/release-metadata.test.mjs` verifies workflow ordering, shared executable invocation, report upload, summary emission, fixture authority, and failure probes; `test/release-receipts.test.mjs` pins the checked-in fixture root/delegated SPKI fingerprints and canonical trust-envelope digest, rejects arbitrary keys reusing fixture IDs, and proves summary-write failure leaves no passing report; `.github/workflows/release.yml` keeps `production-release` dependent on the completed candidate/preflight jobs |
| Strict hydration reconciles the committed Vercel AI Gateway identities withdrawn before patch.11 | Active patch `0018-fix-remove-withdrawn-vercel-models.patch` adds a regression at `hydrateModelDataStructure` for the exact withdrawn identities and proves an unrelated missing Gateway identity still fails |

## Newly withdrawn model identities (#91)

| #91 requirement | Automated evidence |
| --- | --- |
| Reconcile only the two Fireworks and two NVIDIA identities absent from repeated complete public catalog probes | Active patch `0020-fix-remove-newly-withdrawn-models.patch` removes exactly `accounts/fireworks/models/glm-5p1`, `accounts/fireworks/routers/glm-5p1-fast`, `mistralai/mistral-small-4-119b-2603`, and `stepfun-ai/step-3.5-flash` from the committed structural catalog; issue #91 records repeated public models.dev, NVIDIA NIM, OpenRouter, and Vercel counts and absence evidence |
| Preserve strict rejection of unrelated missing and malformed/unknown drift | `packages/ai/test/model-data-validation.test.ts` exercises public `hydrateModelDataStructure`: the exact four withdrawals reconcile, while missing `fireworks/accounts/fireworks/models/glm-5p2` and an `unknown-api` mismatch both fail closed; `model-catalog-retirement` pins this regression in the patch.13 fixture gate |
| Preserve the unpublished patch.13 identity and Manager Release while refreshing every candidate input | `releases/pi-v0.81.1-patch.13/manifest.json`, fixture gate, candidate report, release notes, package/bootstrap projections, and this traceability record select the same untagged patch.13 candidate with `manager-v3` and the ordered 20-patch series |

## ModelRegistry release-gate stability (#87)

| #87 requirement | Automated evidence |
| --- | --- |
| Public config refresh reloads changed custom-model data without waiting for a remote catalog | Active patch `0019-fix-keep-model-config-refresh-offline.patch` strengthens `packages/coding-agent/test/model-registry.test.ts` at public `ModelRegistry.refresh()` plus `getAll()` seams: the stale custom identity disappears, the replacement appears, built-ins remain merged, and a remote `fetch` is forbidden |
| Explicit catalog refresh remains available | The same test file calls the public `ModelRuntime.refresh({ allowNetwork: true, force: true })` path and proves it still requests the remote catalog |
| Suite/load-sensitive timeout is eliminated without a broader timeout or repository serialization | The patch removes the test-local 60-second allowance and makes `ModelRuntime.reloadConfig()` refresh local/cache/auth state with `allowNetwork: false`; the complete `full-pi-suite` release stage retains its normal parallel execution |

The minimized diagnosis replaced `pi.dev` with a local catalog delayed by 500 ms. Before the fix, that server received one request and public config refresh took 515 ms; after the fix, it received none and refresh took 15 ms while loading the replacement model. A 40-run, four-process focused stress loop passed after the fix. Two separately reset-home complete coding-agent runs each passed 1,711 tests with 48 skips, matching the fresh 12-stage gate. The exact commands and ranked hypotheses are preserved on #87.

## Windows release-smoke output assertion (#89)

| #89 requirement | Automated evidence |
| --- | --- |
| Representative valid multiline conformance output passes while a missing or wrong exact 8/8 summary fails | `test/release-smoke-output.test.ps1` executes the release-smoke assertion on native PowerShell; `.github/workflows/ci.yml` runs it on `windows-2025` |
| Release smoke preserves command failure and displays bounded diagnostic output without array-filter truthiness | `scripts/assert-conformance.ps1` captures the native command status before checking one case-sensitive exact summary line and displays only the final 100 lines; `.github/workflows/release.yml` calls that same script for the Windows x64 payload |
| Failed public patch.12 remains immutable while the corrected candidate uses a new identity | `README.md` and `releases/pi-v0.81.1-patch.13/RELEASE_NOTES.md` record patch.12 as unpublished after run `30224148376`; package, bootstrap, manifest, fixture gate, fresh candidate report, install examples, and notes select `pi-v0.81.1-patch.13` with `manager-v3`. Patch #20 later reconciles issue #91's pre-publication model withdrawals without changing that candidate identity |

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
| Production smoke and receipt outputs contain only supported managed targets | `test/release-metadata.test.mjs` — exact `darwin-arm64`, `linux-arm64`, and `linux-x64` Unix smoke matrix plus the five-platform managed receipt filter |

## Documentation and scope

## Managed Windows delivery (#64)

| #64 requirement | Automated evidence |
| --- | --- |
| Explicit enable/disable/uninstall without foreign command or PATH replacement | `test/managed-windows.test.mjs` runs the native Windows filesystem/CLI lifecycle; `test/managed-runtime.test.mjs` exercises `.exe` and `.ps1` collision refusal plus receipt-owned `.cmd` disablement; `scripts/install-windows.ps1` refuses PowerShell aliases, functions, and cmdlets |
| Stock Pi identity and escape boundary | Native Windows lifecycle records a Stock `pi.cmd`, leaves it byte-identical, verifies final resolution, and preserves the downstream-session warning path shared with macOS/Linux |
| Atomic compatible pair selection, patch-only transition, interruption, rollback, holds, recovery, and verification | Native lifecycle installs four same-upstream signed fixture releases, interrupts before the Activation switch, rolls back, corrupts the active executable, fails closed, explicitly recovers, and fully verifies the recovered pair |
| Exclusive lifecycle lock, process-lifetime leases, and executable-lock cleanup | Shared lock/lease race tests remain platform-neutral; native Windows lifecycle proves a live leased old pair survives update and is pruned after lease release; runtime treats only receipt-proven Windows lock errors as deferred cleanup and never schedules deletion |
| Windows x64 and ARM64 release payloads and receipts | `test/release.test.mjs` gates both ZIPs; `test/release-receipts.test.mjs` gates exact five-platform receipt output; `scripts/package-binaries.mjs` embeds the PowerShell/bootstrap payload in both architectures |
| Native CI and release promotion gate | `.github/workflows/ci.yml` runs `test/managed-windows.test.mjs` on `windows-2025`; `.github/workflows/release.yml` smoke-tests the exact x64 ZIP and native lifecycle before protected publication. ARM64 packaging/receipt/selection remain required where hosted native ARM64 runners are unavailable |
| Shared-data preservation and documentation promotion | Native uninstall preserves `%USERPROFILE%\.pi\agent` byte-for-byte; `README.md`, `managed-runtime.md`, this traceability record, and the accepted design document the supported Windows flow |

## Documentation and scope

`README.md` documents installation on macOS, Linux, and Windows, Managed Update, Patch Lag, verification, provenance audit, rollback, recovery, disablement, Stock Pi, uninstall, Legacy Downstream Installation guidance, key rotation/compromise boundaries, and unmanaged source-build fallback. Detailed command and state semantics remain in [`managed-runtime.md`](managed-runtime.md); public signing and key rotation are in [`signing-keys.md`](signing-keys.md) and [`production-signing-runbook.md`](production-signing-runbook.md).

The release candidate remains unpublished until the protected workflow signs it with the human-provisioned delegated key. No production private signing material is created or handled by this acceptance gate.
