# Managed runtime foundation

This is the local runtime delivered by GitHub issue [#59](https://github.com/taylorrowser/pi-wait-for-user/issues/59). It implements the stable Managed Dispatcher and the versioned Manager Release seam defined by [`docs/design/managed-installation.md`](../design/managed-installation.md). Command ownership, network update discovery, and the complete retention/uninstall UX remain assigned to #60–#62.

## Entrypoints

- `scripts/managed-dispatcher.mjs` is stage 0. Normal launches read and cheaply validate one Activation, acquire a pair lease, and invoke only the selected Manager Release. They never search for or run Stock Pi.
- `manager` is the immutable Manager Release executable in the release package. It invokes `scripts/managed-manager.mjs`.
- `scripts/managed-manager.mjs` runs normal Pi with `-e <selected-release>/pi-wait-for-user/question-tool`, implements local activation and verification, and refuses to delegate unknown `managed` commands to Pi.

Stage 0 independently implements `managed recover --previous` and `managed disable`, so neither operation trusts the active Manager Release.

## Local layout

Under the platform-native `pi-wait-for-user` data root:

```text
state/activation.json              atomic active + previous pair
state/accepted-metadata.json       trust and Channel replay checkpoints
state/lifecycle.lock               exclusive mutating-operation owner
managers/<manager-release-id>/     immutable Manager Release payload
releases/<downstream-release-id>/  immutable Downstream Release payload
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

## Verification

From a selected Manager Release:

```text
pi managed verify
pi managed verify --all
pi managed verify --provenance
```

The default command fully verifies the active pair. `--all` also verifies the retained previous pair. Verification repeats local signature, compatibility, receipt, complete payload, reported-version, smoke, and conformance checks. `--provenance` additionally runs online `gh attestation verify` for the cached Manager and Downstream payload artifacts, pinning the manifest repository, signer workflow, and source commit. Normal launch performs only cheap state/pair/receipt/platform/path/executable checks.

## Concurrency and cleanup

One exclusive lifecycle lock records the active operation and serializes mutation. Launches do not take that lock. Each launch creates a uniquely named pair lease before reading payload files, transfers it to the Manager child process, and removes it after the child exits. Cleanup defers a leased pair and retries later.

Staging and deletion use uniquely named `*.tmp-<uuid>` and `*.tombstone-<uuid>` directories with exact owner receipts. Cleanup ignores malformed, foreign, and symlink-substituted paths. Published payload deletion first validates both embedded and central receipts, then moves the payload through a receipt-scoped tombstone.

Only fixture private keys are used by automated tests. This runtime stores pinned public keys and does not create, expose, or accept production signing secrets.
