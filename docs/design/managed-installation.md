# Patch-aware Managed Installation

## Status

Accepted design for GitHub issue #47. This document specifies the managed command-ownership, update, rollback, verification, and uninstall contract. It builds on the immediate identity-integrity fix in #46; it does not delay or replace that fix.

Domain terms are defined in [`CONTEXT.md`](../../CONTEXT.md). In particular, an **Upstream Release** is never itself an install candidate. Only a signed, compatible **Downstream Release** may participate in an **Activation**.

## Goals

- Let an explicitly opted-in user run the downstream distribution as the normal `pi` command.
- Detect and install new downstream patch releases even when the upstream Pi version is unchanged.
- Fail closed when no exact compatible downstream package set exists.
- Preserve Stock Pi, Pi settings, credentials, packages, sessions, and Agent Threads.
- Make install, activation, rollback, recovery, disablement, and uninstall transactional and understandable.
- Give release identity, compatibility, artifacts, and provenance one manifest-authoritative path.

## Non-goals

- Automatically installing an Upstream Release.
- Replacing, moving, copying, updating, or deleting Stock Pi.
- Migrating or rewriting Pi sessions.
- Transactionally rolling back user-managed Pi packages or model catalogs.
- Managed local source builds in the first implementation.
- Managed Windows command ownership in the first implementation. The design is cross-platform, but initial delivery covers the currently supported macOS/Linux installer targets.
- Guaranteeing self-update across unknown future trust or metadata schemas.

## Invariants

1. The normal `pi` command is claimed only after explicit opt-in.
2. A Managed Installation shadows Stock Pi through a manager-owned bin directory; it never edits the stock launcher in place.
3. An unowned launcher path is never overwritten, renamed, backed up, or removed.
4. Every Activation is one compatible `{Manager Release, Downstream Release}` pair selected atomically.
5. A Downstream Release binds an exact upstream repository/tag/commit/version, exact patch series, exact Question Tool identity and compatibility, exact session/protocol/handler compatibility, and exact platform artifacts.
6. An Upstream Release or upstream version notice can never become an activation candidate.
7. A new downstream patch release is an update even when its upstream version is unchanged.
8. Installation and activation verify authenticated metadata and all declared payload identities before changing the active pair.
9. An interrupted or failed install/update leaves the prior Activation selected.
10. A launch that cannot validate the selected Activation fails closed. It never falls through to Stock Pi.
11. Stock Pi, `~/.pi/agent`, and configured session directories are outside manager ownership.
12. Cleanup removes only paths proven manager-owned by receipts and state.

## Architecture

### Stable dispatcher and versioned pairs

The manager-owned `pi` and `pi-wait-for-user` entrypoints invoke a tiny stable stage-0 **Managed Dispatcher**. Stage 0 owns only enough behavior to:

- validate and read the local activation state;
- invoke the selected versioned Manager Release;
- obtain a lifetime lease for the selected pair;
- fail closed with bootstrap-independent recovery instructions;
- explicitly recover the retained previous pair; and
- disable managed ownership when the selected manager is unusable.

Lifecycle logic lives in immutable, versioned Manager Release directories. Normal Pi execution lives in immutable, versioned Downstream Release directories. One atomically replaced activation record selects both. A managed update may install a new manager, a new downstream release, or both, but it switches them as one pair.

The active record also identifies the retained previous pair. A normal launch never silently switches to it. `pi managed recover --previous` explicitly verifies and selects it when the active pair is unusable.

### Command ownership

Managed ownership is explicit:

```text
install.sh --manage-pi
pi-wait-for-user managed enable
```

Plain installation remains side-by-side for backward compatibility. Enabling management:

1. detects and records the currently resolved Stock Pi executable and observable identity, if one exists;
2. verifies that the chosen managed launcher paths are absent or already manager-owned;
3. installs and verifies an Activation;
4. writes the stable dispatcher and compatibility alias atomically;
5. verifies that the current environment resolves `pi` to the Managed Dispatcher; and
6. reports success only after that resolution check passes.

The installer does not edit shell startup files. If the managed bin directory does not win PATH resolution, the release may remain installed but managed enablement is incomplete and nonzero. The command prints exact PATH or `--bin-dir` remediation; rerunning enablement converges safely.

`pi managed disable` removes only the manager-owned normal `pi` entrypoint. It retains `pi-wait-for-user`, installed releases, manager state, and user data, returning the installation to side-by-side use.

`pi-wait-for-user` remains a compatibility alias to the same dispatcher and active pair. It is not pinned to the release that first installed it.

### Stock Pi escape hatch

The manager records the pre-management Stock Pi executable path and identity without copying or modifying it.

```text
pi managed stock -- <stock-pi-arguments>
```

This command rechecks the recorded path, prevents dispatcher recursion, warns that Stock Pi cannot open downstream session files, and then executes Stock Pi. If the path is missing or no Stock Pi was recorded, it fails clearly. `pi managed disable` is the durable escape hatch that restores normal PATH resolution to Stock Pi, if one remains installed.

A package manager or version manager remains free to update or remove Stock Pi independently. Manager status reports divergence from the originally recorded identity; the manager does not claim ownership of that change.

## Release authority and trust

### Release Channel

A generated, signed `channel.json` at a stable raw GitHub repository URL is the sole mutable promotion pointer. It supersedes `releases/active.json`. During migration, any `active.json` compatibility output must be generated from the channel and verified; it must not remain an independent authority.

The Release Channel has a monotonic sequence and selects one Release Manifest. The manager persists the highest accepted sequence, selected manifest identity, and canonical complete-envelope digest. It rejects lower signed sequences as replay and accepts an equal sequence only for a canonical-envelope-identical retry. A deliberate local rollback does not lower this value.

The channel URL is carried by authenticated trust metadata so hosting can migrate without changing release identity. GitHub Releases continue to host immutable artifacts.

### Release Manifest

One signed immutable Release Manifest is authoritative for:

- release ID and tag;
- exact upstream repository, tag, commit, and package version;
- ordered patch paths and digests;
- the exact Question Tool package separately from its manifest, schema, protocol, handler identity, and versions;
- downstream session identities and readable protocol/handler versions;
- Manager Release compatibility and only artifacts that implement that named Manager Release;
- bootstrap installer and release-gate definitions/reports in their explicit roles;
- platform binary artifacts, extracted payload inventory, digests, and sizes;
- required release-gate and conformance results;
- provenance repository/workflow identity; and
- release notes needed for user-facing compatibility status.

`SHA256SUMS`, archive `release.json`, receipts, launch checks, docs, and package/bootstrap identity lines are generated projections. They are not independent identity authorities. Packaging and payload verification share one filesystem inventory contract, including normalized paths, symlink/file-kind rejection, size, digest, and declared mode. #46 first makes current duplicated values fail closed; this design then removes those manual copies.

### Signing keys

The Managed Dispatcher pins an offline root public key. Versioned root-signed trust metadata authorizes expiring release keys. Authorized release keys sign Release Channels and Release Manifests.

- Routine release-key rotation or revocation uses newer root-signed trust metadata. The manager persists the highest accepted trust version and canonical complete-envelope digest, rejecting lower versions and non-identical equal-version retries.
- Normal root rotation is cross-signed by old and new roots and distributed through a compatible dispatcher update.
- Suspected root compromise requires an explicitly reviewed new bootstrap. A remote chain trusted only because the compromised root signed it cannot repair that trust boundary.
- Unknown trust, channel, or release-manifest schemas fail closed while leaving the active pair usable. The user is instructed to rerun the reviewed bootstrap.

### Bootstrap trust

The fast installer continues to use an HTTPS-fetched, reviewable bootstrap script. That script is the initial trust event; it embeds the project root key and verifies signed metadata before activating any payload. Documentation must not claim that a curl-piped script authenticates itself.

A checksum/GitHub-attestation-first manual bootstrap path is also documented for users who want an independent first-install check. Subsequent managed updates use the pinned-key chain.

### Provenance

Release promotion must verify GitHub build provenance for every published artifact and record the expected repository/workflow identity in the signed Release Manifest. Client installation and activation require project signatures, manifest identity checks, and artifact/payload digests. They do not require an online Sigstore check.

`pi managed verify --provenance` performs an optional online provenance audit. Offline rollback remains possible from previously verified local content.

## Update discovery and command behavior

### Patch-aware selection

The manager compares the active release ID and accepted channel sequence with the signed channel selection. It does not compare only upstream semantic versions. Therefore this is a normal managed update:

```text
pi-v0.81.1-patch.3 -> pi-v0.81.1-patch.4
```

as is an upstream rebase:

```text
pi-v0.81.1-patch.4 -> pi-v0.82.0-patch.1
```

A changed Manager Release or Question Tool compatibility set is published as a new Downstream Release identity and is detected through the same channel mechanism.

The official upstream `https://pi.dev/api/latest-version` response is informational only. It can establish **Patch Lag**, but it cannot select an artifact.

### Startup checks

Managed startup suppresses upstream Pi's stock update notice. At most once per configured throttle period (initially 24 hours), the manager refreshes channel and upstream status without delaying normal startup. Startup renders only safe cached status in interactive mode:

- a compatible Downstream Release is available; or
- Patch Lag exists and the current verified release remains active.

`PI_SKIP_VERSION_CHECK` suppresses managed version checks and notices. `PI_OFFLINE` suppresses all startup network work. JSON, print, and RPC output must not be polluted by human update notices.

### `pi update`

The Managed Dispatcher intercepts every `update` invocation before Pi core can reach its upstream self-updater.

- `pi update`, `pi update pi`, `pi update self`, and `--self` perform a Managed Update.
- `--extensions`, `--models`, and one-package update forms delegate to active Pi only when the Manager Release explicitly recognizes them as self-excluding.
- `--all` performs an ordered Managed Update phase followed by the active new Pi's package-update phase.
- If the package phase fails after successful activation, the new release remains active, the command exits nonzero, and the partial result is explicit. Shared package mutations are never represented as transactionally rolled back.
- Unknown update syntax fails closed rather than being delegated to a possible upstream self-update path.

An explicit update is synchronous and bypasses an Update Hold for the exact candidate. A successful activation clears that hold.

## State machines

### Command ownership

| State | Event | Result |
| --- | --- | --- |
| Side-by-side | `managed enable` with foreign launcher collision | Remain side-by-side; fail nonzero; modify nothing. |
| Side-by-side | `managed enable` with losing PATH order | Install/verify payload if needed; do not claim success; print remediation. |
| Side-by-side | `managed enable` with verified pair and winning PATH | Atomically publish owned entrypoints; become managed. |
| Managed | repeated `managed enable` | Verify and report already managed; exit 0. |
| Managed | `managed disable` | Remove only owned `pi`; retain compatibility alias/state/releases; become side-by-side. |
| Side-by-side | repeated `managed disable` | Report already disabled; exit 0. |
| Any | ownership mismatch | Fail closed; never force convergence over foreign paths. |

### Managed update and activation

```text
Active
  -> Checking signed trust/channel metadata
  -> Staging manager/release artifacts in manager-owned temporary paths
  -> Verifying signatures, sequence, identities, platform, digests, payload inventory
  -> Running version, smoke, and conformance checks
  -> Publishing immutable versioned directories
  -> Atomically switching the activation pair
  -> Retention cleanup (never before the switch)
  -> Active
```

Failure behavior:

- Metadata/network failure during explicit update: current pair remains active; command fails nonzero with a stage-specific diagnostic.
- Candidate verification failure: delete executable temporary payload, retain a small diagnostic record, leave activation untouched, and fail nonzero.
- Interruption before atomic switch: current pair remains active.
- Interruption after atomic switch: new verified pair is active; cleanup is retried later.
- Patch Lag: no candidate is staged; `pi update` exits 0 and reports current downstream ID/upstream version plus the observed newer upstream version.
- Upstream informational endpoint failure does not invalidate a successfully checked Release Channel.

Normal launches read the old or new complete activation record. They never observe a half-pair.

### Rollback

`pi managed rollback` targets the immediately previous successfully active local pair. `--to <release-id>` may target another locally installed verified pair; rollback never downloads.

```text
Active current + retained previous
  -> Re-verify target signatures/receipts/payload requirements
  -> Warn about session compatibility boundary
  -> Atomically select target pair
  -> Retain pair being left as the new previous pair
  -> Record an Update Hold for the exact rolled-back-from release
```

Any failure leaves the current pair active. The hold suppresses only passive startup notices for that exact release. A later channel release is announced normally. Explicit `pi update` retries the channel candidate. `pi managed unhold` clears the hold without updating.

### Launch recovery

Each launch cheaply validates activation-state schema, selected pair identities, receipts, platform, and required executables. If validation fails, normal `pi` exits without running Pi and prints:

- `pi managed recover --previous` to explicitly verify and reactivate the retained pair; and
- `pi managed disable` to return command ownership to Stock Pi.

Stage 0 implements these emergency operations without trusting the broken active manager. There is no automatic fallback.

### Uninstall

`pi managed uninstall`:

1. validates every entrypoint and state path against manager receipts;
2. atomically removes/disables the manager-owned normal `pi` path so subsequent resolution reaches Stock Pi or no Pi;
3. removes the manager-owned compatibility alias;
4. removes unleased Manager Release and Downstream Release directories, activation/channel state, caches, diagnostics, receipts, and safe temporary/tombstone paths;
5. marks leased payloads for deferred deletion; and
6. reports the resulting Stock Pi path/identity or that no `pi` remains.

It removes pinned releases because full uninstall ends manager ownership. It never removes Stock Pi or anything under Pi's shared settings/session directories.

Repeated uninstall of an absent managed installation is a successful no-op. Foreign files, inconsistent receipts, or ownership mismatches fail nonzero and remain untouched.

## Retention, leases, and concurrency

After successful activation, automatic retention keeps:

- the active pair;
- the immediately previous successfully active pair;
- every explicitly Pinned Release/pair; and
- every pair with a live process lease.

Older unpinned and unleased manager-owned pairs are pruned only after activation. Users manage additional retention through `pi managed pin`, `unpin`, and `prune`.

The dispatcher holds an OS-backed lease for the selected manager/release pair for the lifetime of each Pi child process. Update and rollback remain allowed while older Pi processes run. Prune and uninstall mark leased directories pending cleanup and remove them during a later safe lifecycle pass.

Only one mutating lifecycle operation may hold the manager lock at a time. Normal launches are lock-free except for acquiring their pair lease and may continue on the old pair while an update stages. A concurrent lifecycle command reports the active operation rather than corrupting shared state.

Manager-owned temporary paths are uniquely named and receipt-scoped. A retry removes or resumes only temporary/tombstone state whose ownership is proven.

## Verification

Verification is layered:

### Every launch

- activation/state schema;
- compatible manager/release pair identity;
- receipt identity and platform;
- required dispatcher, manager, Pi, Question Tool, and manifest files;
- recursion/path sanity.

### Install, activation, and `pi managed verify`

- root/delegated-key authorization and signatures;
- channel sequence/replay policy;
- Release Channel to Release Manifest identity/digest;
- full compatibility tuple;
- artifact digest and size;
- extracted payload inventory and file digests;
- manager and Pi reported versions;
- smoke checks and public conformance.

`verify --all` checks all retained pairs. `verify --provenance` adds the online GitHub provenance audit.

A verified artifact is staged in a temporary path and published immutably. Local modification later causes explicit verification to fail; it is never repaired by silently trusting a receipt.

## User-visible scenarios

| Scenario | Required result |
| --- | --- |
| Fresh plain install | Install side-by-side; `pi-wait-for-user` works; existing `pi` is untouched. |
| Fresh `--manage-pi` with no Stock Pi | Install verified pair; claim `pi` only if PATH and launcher ownership checks pass; disable/uninstall may leave no `pi`. |
| Fresh `--manage-pi` with Stock Pi | Record Stock Pi; shadow it; expose `managed stock`; never alter stock-owned files. |
| Existing legacy downstream install | Fully verify against trusted signed payload inventory before adoption; otherwise install fresh and leave legacy directory with explicit cleanup instructions. |
| New downstream patch, same upstream | Startup announces it; `pi update` verifies and atomically activates it. |
| Compatible upstream rebase | Same as any other new Downstream Release; exact compatibility is manifest-checked. |
| Patch Lag | Keep current verified pair; exit 0 from explicit update; show current downstream/upstream and newer observed upstream. |
| Failed verification | Delete temporary executable payload; retain diagnostic metadata; leave current pair active; fail explicit update nonzero. |
| Rollback | Re-verify local prior pair; atomically switch; hold exact rejected release; touch no sessions/settings. |
| Stock execution | Warn that Stock Pi cannot open downstream sessions; execute only the recorded stock command. |
| Disable managed ownership | Remove only owned `pi`; retain side-by-side alias/releases/state. |
| Uninstall | Remove all and only manager-owned product state; preserve Stock Pi and shared Pi data. |
| Unknown metadata schema | Keep active pair usable; fail update and require reviewed re-bootstrap. |
| Corrupt active pair | Normal launch fails closed; explicit previous-pair recovery or managed disable remains available. |

## Session compatibility

The Release Manifest declares the downstream session identities and exact protocol/handler versions readable by the release. `pi managed status` shows:

- active downstream release and based-on upstream Pi version;
- active Manager Release;
- supported downstream session/header identity;
- supported durable-deferral protocol and Question Tool handler versions;
- recorded Stock Pi identity;
- channel/update/hold/Patch Lag state.

`pi managed stock` always warns that Stock Pi cannot open downstream session files. Rollback warns that newer sessions may reject or reconstruct as unavailable. The manager does not pre-scan sessions and does not migrate them.

Actual session opening remains Pi core's responsibility and follows the accepted #10 compatibility contract:

- unsupported session identities/versions reject before mutation;
- recognized unsupported protocol/handler/tool combinations open non-advancing as unavailable where the format permits;
- no installer or launcher silently rewrites persisted identities.

## Filesystem ownership

Default data roots remain platform-native:

- macOS: `$HOME/Library/Application Support/pi-wait-for-user`
- Linux: `${XDG_DATA_HOME:-$HOME/.local/share}/pi-wait-for-user`

The default bin directory remains `$HOME/.local/bin`, subject to PATH and collision checks. The manager data root separates immutable manager releases, immutable downstream releases, activation/channel/trust state, receipts, leases, diagnostics, cache, and temporary/tombstone paths.

Receipts include schema, owned path, content identity, release/manager identity, platform, and creation provenance sufficient to prove cleanup ownership. Paths are validated against traversal and symlink substitution before mutation. Shared Pi data is never listed in a manager receipt.

## Lifecycle idempotency

Commands converge safely:

- install/enable of an already healthy current pair: exit 0, already installed/managed;
- disable when already side-by-side: exit 0;
- uninstall when no managed installation exists: exit 0;
- retry after interruption: resume or clean only proven manager-owned staging/tombstone paths;
- ownership mismatch, foreign collision, malformed state, or unverifiable content: fail nonzero and modify nothing outside proven temporary state.

## Platform and migration plan

The metadata, Activation, receipt, lease, and lifecycle state machines are cross-platform. Initial managed implementation targets macOS/Linux ARM64 and x64, matching the supported one-command bootstrap. Existing Windows ARM64/x64 archives remain manual and side-by-side. A blocked follow-up ticket implements equivalent Windows entrypoint, atomic replacement, locking, leases, and uninstall semantics.

The first managed implementation accepts only publisher-built artifacts declared by the signed Release Manifest. The existing source-build path remains an unmanaged side-by-side fallback. Supporting locally built managed payloads requires a separate signed-input/local-build receipt design.

## Required tests

Tests must cover state transitions and observable filesystem/CLI behavior, not private helper structure.

### Metadata and release pipeline

- patch-only channel advancement is detected;
- upstream rebase advancement is detected;
- lower channel sequence is rejected;
- equal-sequence retry succeeds;
- unknown/expired/unauthorized keys and schemas fail closed;
- every generated identity projection matches the Release Manifest;
- #46's hardcoded-drift mutation remains rejected;
- provenance mismatch blocks promotion.

### Installation and ownership

- fresh install with/without Stock Pi;
- explicit opt-in requirement;
- PATH losing/winning cases;
- foreign launcher collision;
- idempotent reruns;
- legacy verify/adopt and reinstall-without-delete paths;
- `pi-wait-for-user` compatibility alias and managed disable/re-enable;
- strict receipt/symlink/traversal cleanup checks.

### Update and activation

- manager-only, patch-only, Question-Tool, and upstream-rebase pair changes;
- interruption at every staging/publish/activation boundary;
- signature, digest, identity, platform, smoke, and conformance failure;
- Patch Lag and upstream informational endpoint failure;
- unknown update syntax rejection;
- extension/model delegation and `--all` partial failure;
- cached startup notices and offline/version-check controls;
- JSON/print/RPC output isolation.

### Rollback, retention, and recovery

- previous and explicit-local rollback;
- no rollback downloads;
- exact-release Update Hold behavior;
- explicit update retry and later-release notice;
- active/previous/pinned retention;
- live-process lease cleanup deferral;
- corrupt-active fail-closed launch;
- stage-0 previous recovery;
- disable to Stock Pi or no Pi.

### Uninstall

- full manager-owned cleanup;
- preservation of Stock Pi and all shared Pi data;
- leased deferred deletion;
- interrupted and repeated uninstall;
- refusal on foreign paths or inconsistent receipts;
- final command resolution messaging.

## Delivery dependencies

- #46 is the completed independent baseline for release identity integrity.
- #57 adds the signed Release Channel, complete Release Manifest, and release metadata tooling on top of #46.
- #58 is the human-controlled production key provisioning and first channel publication; it is blocked by #57.
- #59 builds the stable dispatcher and local Activation engine; it is blocked by #57.
- #60 adds macOS/Linux command ownership and migration; it is blocked by #59.
- #61 adds network update discovery/routing and Patch Lag UX; it is blocked by #59.
- #62 adds rollback, retention, recovery, and uninstall on the shared lifecycle primitives; it is blocked by #59 and #60.
- #63 is the macOS/Linux end-to-end release gate; it is blocked by #58, #60, #61, and #62.
- #64 adds equivalent managed Windows support after #63.
- Managed local source builds remain an explicit future design rather than part of these tickets.
