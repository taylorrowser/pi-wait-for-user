# Managed Installation components and command ownership

This local runtime implements the stable Managed Dispatcher, versioned Manager Release seam, macOS/Linux command ownership, patch-aware Managed Update flow, rollback, retention, recovery, and uninstall defined by [`docs/design/managed-installation.md`](../design/managed-installation.md). GitHub issue [#59](https://github.com/taylorrowser/pi-wait-for-user/issues/59) delivered Activation; [#60](https://github.com/taylorrowser/pi-wait-for-user/issues/60) added Command Ownership and Legacy Downstream Installation adoption; [#61](https://github.com/taylorrowser/pi-wait-for-user/issues/61) added authenticated network discovery, update routing, startup status, and Patch Lag; and [#62](https://github.com/taylorrowser/pi-wait-for-user/issues/62) completes the local lifecycle state machines.

## Entrypoints

- `scripts/managed-dispatcher.mjs` is stage 0. Normal launches read and cheaply validate one Activation, acquire a pair lease, and invoke only the selected Manager Release. They never search for or run Stock Pi.
- `manager` is the immutable Manager Release executable in the release package. It invokes `scripts/managed-manager.mjs`.
- `scripts/managed-manager.mjs` runs normal Pi with `-e <selected-release>/pi-wait-for-user/question-tool`, implements local Activation, verification, Compatibility Entrypoint installation, `managed enable`, and `managed stock`, and refuses to delegate unknown `managed` commands to Pi.

`scripts/managed-installer.mjs` is the signed-payload installer engine that #63 projects into the release `install.sh` flow. It reads only a packaged `managed-root-keys.json`; neither the trust anchor nor the verification clock is caller-selectable. Command Ownership is refused for a pair created through the low-level caller-key activation seam, and the stable Dispatcher embeds the installer-pinned root-key configuration. The production HTTPS bootstrap assembled by #63 supplies that #58-provisioned root-key configuration and authenticated metadata URLs. The checksum/attestation-first manual path independently verifies the same packaged public key before invocation. The engine accepts only an explicit `--manage-pi`; without that flag a signed installation publishes only the owned `pi-wait-for-user` compatibility entrypoint. It remains side-by-side until either `install.sh --manage-pi` is selected or the user runs:

```text
pi-wait-for-user managed enable [--bin-dir <directory>]
```

Enable defaults to `$HOME/.local/bin`, records the currently PATH-resolved Stock Pi path, resolved executable, SHA-256, size, and reported version, then atomically publishes `pi` last. Both command names target the same immutable, receipt-owned Dispatcher. Stage 0 independently implements `managed recover --previous` and `managed disable`; disable removes only `pi` and retains the compatibility entrypoint, state, and releases.

## Local layout

Under the platform-native `pi-wait-for-user` data root:

```text
state/activation.json              atomic active + previous pair
state/accepted-metadata.json       trust and Channel replay checkpoints
state/entrypoints.json             strict Command Ownership and Stock Pi Identity receipt
state/compatibility-entrypoint.json side-by-side compatibility ownership
state/legacy-adoption.json         Legacy Downstream Installation adoption result and cleanup text
state/lifecycle.lock               exclusive mutating-operation owner
state/lifecycle-recovery-*.json    durable stale-owner recovery claims
state/update-status.json           last safe authenticated Channel/upstream status
state/startup-check.json           24-hour startup-check throttle
state/update-hold.json             exact Downstream Release hold projection
state/rollback-transaction.json     crash-safe rollback pair/hold commit intent
state/update-hold-clear-transaction.json crash-safe successful-reactivation hold clear
state/pinned-releases.json          verified pairs exempt from automatic retention
state/pending-cleanup.json          leased pairs awaiting a later lifecycle pass
state/uninstall-pending.json        receipt-bound pairs awaiting uninstall cleanup
dispatcher/                        immutable receipt-owned stage 0 copied from a verified Manager Release
managers/<manager-release-id>/     immutable Manager Release payload
downstream-releases/<downstream-release-id>/ immutable Downstream Release payload
releases/<downstream-release-id>/         untouched Legacy Downstream Installations
receipts/{managers,releases}/      strict receipt projections
artifacts/<sha256>/                verified artifact bytes for provenance audit
leases/<manager>--<downstream>/    process-lifetime pair leases
tmp/                               receipt-scoped staging and tombstones
diagnostics/                       small non-executable failure records
```

Activation and receipt readers reject unknown/missing fields, foreign owned paths, traversal, symlink substitution, platform mismatch, pair mismatch, and missing required executables. Payload directories are derived from validated IDs rather than read from Activation. Signed trust, Channel, and Release Manifest envelopes are stored with each Downstream Release; receipt identities bind both payload directories to that signed manifest and their signed source artifacts.

## Activation transaction

`managed activate` requires a pinned root public key plus trust, Channel, Release Manifest, Manager Release archive, and platform Downstream Release archive. It performs, in order:

1. root/delegated signature, expiry, and replay verification;
2. Channel-to-manifest identity and digest verification;
3. platform and Manager Release compatibility checks;
4. signed artifact size/digest checks and traversal/symlink-safe extraction;
5. complete extracted Downstream Release inventory/digest/mode verification;
6. Manager, Pi, and Question Tool reported identity checks;
7. Pi smoke and public conformance checks;
8. immutable publication of both versioned payloads and strict receipts; and
9. one fsynced temporary-file rename selecting the complete pair.

The previous successfully active pair is copied into the new Activation. The crash checkpoints exercised by the test suite are `manager-staged`, `downstream-staged`, `metadata-accepted`, `manager-published`, `downstream-published`, `before-activation-switch`, and `after-activation-switch`. Before the last checkpoint the old pair remains selected; after it the new pair and its retained previous pair are complete.

Unknown signed metadata schemas fail activation with reviewed re-bootstrap instructions, but stage 0 does not need to parse those envelopes during a cheap launch, so an already active pair remains usable.

## Patch-aware Managed Update

The active, previously authenticated trust document supplies the base location for `release-trust.json`. A newly fetched root-signed trust document authenticates the Channel URL; the signed Channel authenticates the Release Manifest URL and digest; only that manifest supplies Manager Release and platform Downstream Release artifact names, sizes, and digests. Artifact URLs are resolved beside the immutable manifest URL. `https://pi.dev/api/latest-version` is queried separately and can establish Patch Lag only—it never supplies a URL, release identity, or artifact.

The Manager Release classifies `pi update` before invoking Pi core:

- `pi update`, positional `pi|self`, `--self`, and their known force forms run a Managed Update;
- `--all` (including Pi's known self-plus-extensions aliases) activates first, then invokes `update --extensions` through the newly active Pi;
- `--extensions`, `--models`, and documented one-package forms delegate unchanged to active Pi; and
- every other update shape fails closed.

When `--force` finds no compatible candidate to activate, the Managed Update fully verifies the current Activation instead of silently discarding the option. A package-phase failure after `--all` is an explicit nonzero partial result and never rolls back the verified Activation. Discovery, download, signature, digest, identity, smoke, and conformance failures retain the current Activation, remove receipt-scoped temporary payloads, and retain at most ten strictly validated manager-owned, non-executable stage diagnostics; foreign diagnostic files are untouched. The highest authenticated trust version and Channel sequence are persisted as soon as the complete signed metadata chain is accepted, even if payload download later fails; equal retries must be envelope-identical and lower versions/sequences are rejected. Patch-only, Manager Release, Question Tool, and upstream-rebase changes are all selected by Channel sequence plus exact Downstream Release identity rather than by upstream semantic version.

Explicit updates are synchronous. Normal launch instead renders only a cache whose active pair and Channel sequence/identity still match the authenticated Activation checkpoints, then starts a detached refresh process. That detached process—not the launching process—claims the throttle and performs at most one refresh per 24 hours, so normal launch remains lock-free apart from its pair lease. `PI_SKIP_VERSION_CHECK`, `PI_OFFLINE`, and `--offline` suppress refresh; Pi core always receives `PI_SKIP_VERSION_CHECK=1` so its upstream-only notice cannot conflict with managed status. Human notices are emitted only when Pi will enter its interactive TUI, never metadata/package commands, print, JSON, or RPC output.

`pi managed status` reports the active pair and platform; upstream basis; session identities, readable protocol versions, readable handler versions, and the active Question Tool handler; recorded Stock Pi Identity and any observed divergence; Channel sequence/candidate; compatible Downstream Release; Patch Lag; and Update Hold. An exact hold suppresses only its passive compatible-update notice. Explicit update bypasses it and clears it after activation.

If a Legacy Downstream Installation for the selected release exists, Activation compares every file path, mode, size, and digest with the signed platform payload. Only an exact match is adopted into the managed staging tree. Otherwise Activation installs the fresh signed archive under `downstream-releases/`, leaves the Legacy Downstream Installation unchanged, and records exact manual cleanup guidance.

## Rollback, retention, and recovery

`pi managed rollback` fully re-verifies the retained previous local pair before one atomic Activation switch. `--to <release-id>` selects only an already installed, fully verified pair and performs no network work. Before switching, rollback durably records one receipt-bound transaction containing the source pair, target pair, and exact Update Hold, then projects `state/update-hold.json` for older immutable Manager Releases. While the source remains active that exact-source hold is inert; after the switch both old and new managers observe it. The old stable Dispatcher continues to read the schema-v1 Activation, while new hold readers also recognize a committed transaction. A crash before the switch therefore leaves the old pair selected; a crash after it exposes the complete target pair and exact new hold. `pi managed unhold` clears the projection before retiring transaction intent; passive startup notices suppress only an exact held candidate, while explicit `pi update` uses the symmetric hold-clear transaction so successful reactivation does not resurrect the hold.

Automatic post-activation retention keeps the active pair, previous pair, every Pinned Release pair, and every live-leased pair. `pi managed pin [release-id]` and `unpin [release-id]` default to the active release. `pi managed prune` removes older receipt-proven pairs and records leased pairs for retry. Cleanup starts only after the Activation switch, and a later activation, prune, or explicit cleanup pass converges deferred work after leases end.

Normal launch still fails closed when the active pair is unusable. Stage 0 alone implements `managed recover --previous` and `managed disable`; it never automatically starts the previous pair or Stock Pi.

## Ownership safety and Stock Pi

Both launcher paths are preflighted before the Dispatcher or ownership state is published. Any file or symlink without the matching manager receipt is a hard collision; there is no overwrite, backup, rename, or force option. Compatibility is published before `pi`, so interruption cannot claim the normal command without a working compatibility path. Retries verify receipts and converge.

Enable succeeds only when fresh command resolution selects the owned `pi`. A losing PATH reports the selected command, the exact managed bin directory ordering to apply, `hash -r` remediation, and exits nonzero without editing shell startup files. The verified pair and owned entrypoints remain available for a convergent retry.

`pi managed stock -- <args>` rechecks every recorded Stock Pi identity field, rejects a missing/changed executable and Dispatcher recursion, warns that Stock Pi cannot open downstream session files, then executes only that recorded command. npm-, pnpm-, Bun-, and mise-style symlink paths remain untouched. No ownership or migration operation reads or writes `~/.pi/agent` or other shared Pi data.

## Uninstall

`pi managed uninstall` preflights the complete receipt-owned installation before mutation. It removes the owned normal `pi` entrypoint first, then the Compatibility Entrypoint, all unleased Manager and Downstream Releases (including pinned pairs), Activation/channel/trust state, receipts, artifacts, diagnostics, and safe receipt-scoped temporary state. Foreign launchers, inconsistent receipt copies, malformed ownership state, payload changes, and symlink substitution fail closed before either command path is removed.

A live pair is recorded for deferred deletion and remains under its receipts until a later bootstrap or lifecycle pass can prove its lease ended. Pair, Manager, and Dispatcher deletion uses source-path- and identity-scoped tombstone receipts; retries cover owner publication, payload rename, tombstone removal, and central-receipt removal independently. Repeated uninstall then converges. Stock Pi and shared Pi settings, credentials, packages, sessions, and Agent Threads are never receipt-owned and remain untouched. Disable and uninstall report the Stock Pi path/version that will resolve, or report that no `pi` command remains.

## Verification

From a selected Manager Release:

```text
pi managed verify
pi managed verify --all
pi managed verify --provenance
```

The default command fully verifies the active pair. `--all` also verifies the retained previous pair. Verification repeats local signature, compatibility, receipt, complete payload, reported-version, smoke, and conformance checks. `--provenance` additionally runs online `gh attestation verify` for the cached Manager and Downstream payload artifacts, pinning the manifest repository, signer workflow, and source commit. Normal launch performs only cheap state/pair/receipt/platform/path/executable checks.

## Concurrency and cleanup

One exclusive lifecycle lock records the active operation and serializes mutation, including the entire managed-plus-package `--all` sequence. Atomic durable recovery claims ensure only one contender may remove a dead owner's stale lock. Launches do not take that lock. Each launch creates a uniquely named pair lease before reading payload files, transfers it to the Manager child process, and removes it after the child exits. Cleanup defers a leased pair and retries later.

Staging and deletion use uniquely named `*.tmp-<uuid>` and `*.tombstone-<uuid>` directories with exact owner receipts. Cleanup ignores malformed, foreign, and symlink-substituted paths. Published payload deletion first validates both embedded and central receipts, then moves the payload through a receipt-scoped tombstone.

Only fixture private keys are used by automated tests. This runtime stores pinned public keys and does not create, expose, or accept production signing secrets.

## Ticket traceability

Issue #61 acceptance behavior is exercised in `test/managed-runtime.test.mjs`: pair-change selection (patch-only, Manager Release, Question Tool, and upstream rebase), replay/schema/outage handling, immutable identity reuse rejection, streamed artifact downloads, reported-identity/smoke/conformance failure boundaries, atomic activation, Patch Lag, update syntax routing, `--all` partial results, retryable startup throttling/output isolation, safe cached status, and Dispatcher-level proof that no self-inclusive update form reaches Pi core. The Activation crash/failure matrix from #59 remains the shared verification seam used by Managed Update.

Issue #62 behavior is exercised at the same filesystem/CLI seam: previous and explicit-local rollback, exact Update Holds and unhold, rollback and hold-clear interruption boundaries, active/previous/pinned/live-leased retention, convergent prune, corrupt-active fail-closed launch and explicit recovery, receipt-safe uninstall, foreign entrypoint/state/lease refusal, current-process lease deferral, retry across every payload/tombstone/receipt uninstall boundary, absent-install no-op, final Stock Pi resolution, and preservation hashes for settings, credentials, packages, sessions, and Agent Threads. Post-switch adoption, retention, hold, or status cleanup is reported explicitly as deferred while the complete new Activation remains selected.
