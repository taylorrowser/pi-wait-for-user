# Managed Installation components and command ownership

This local runtime implements the stable Managed Dispatcher, versioned Manager Release seam, and macOS/Linux command ownership defined by [`docs/design/managed-installation.md`](../design/managed-installation.md). GitHub issue [#59](https://github.com/taylorrowser/pi-wait-for-user/issues/59) delivered Activation; [#60](https://github.com/taylorrowser/pi-wait-for-user/issues/60) adds the side-by-side Compatibility Entrypoint, explicit Command Ownership, Stock Pi Identity recording, and Legacy Downstream Installation adoption. Network update discovery and the complete retention/uninstall UX remain assigned to #61–#62.

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
state/entrypoints.json             strict command-ownership and Stock Pi receipt
state/compatibility-entrypoint.json side-by-side compatibility ownership
state/legacy-adoption.json         Legacy Downstream Installation adoption result and cleanup text
state/lifecycle.lock               exclusive mutating-operation owner
dispatcher/                        immutable receipt-owned stage 0 copied from a verified Manager Release
managers/<manager-release-id>/     immutable Manager Release payload
downstream-releases/<downstream-release-id>/ immutable Downstream Release payload
releases/<downstream-release-id>/         untouched legacy side-by-side installations
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

If the legacy side-by-side directory for the selected release exists, activation compares every file path, mode, size, and digest with the signed platform payload. Only an exact match is adopted into the managed staging tree. Otherwise activation installs the fresh signed archive under `downstream-releases/`, leaves the legacy directory unchanged, and records exact manual cleanup guidance.

## Ownership safety and Stock Pi

Both launcher paths are preflighted before the Dispatcher or ownership state is published. Any file or symlink without the matching manager receipt is a hard collision; there is no overwrite, backup, rename, or force option. Compatibility is published before `pi`, so interruption cannot claim the normal command without a working compatibility path. Retries verify receipts and converge.

Enable succeeds only when fresh command resolution selects the owned `pi`. A losing PATH reports the selected command, the exact managed bin directory ordering to apply, `hash -r` remediation, and exits nonzero without editing shell startup files. The verified pair and owned entrypoints remain available for a convergent retry.

`pi managed stock -- <args>` rechecks every recorded Stock Pi identity field, rejects a missing/changed executable and Dispatcher recursion, warns that Stock Pi cannot open downstream session files, then executes only that recorded command. npm-, pnpm-, Bun-, and mise-style symlink paths remain untouched. No ownership or migration operation reads or writes `~/.pi/agent` or other shared Pi data.

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
