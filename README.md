# Pi Wait for User

A maintained downstream Pi release that can stop an Agent Thread for durable human input, survive complete process teardown, and continue through an explicit Response, Interruption, Cancellation, resume, or abandonment path.

The packaged release candidate is **`pi-v0.81.1-patch.11`**. It combines:

- the exact upstream Pi `v0.81.1` source at commit `20be4b18d4c57487f8993d2762bace129f0cf7c6`;
- the seventeen ordered downstream patches in [`patches/active`](patches/active); and
- the independently versioned Question Tool `@taylorrowser/pi-question-tool@0.1.4`.

## Install on macOS or Linux

### Requirements

- macOS on Apple Silicon, or Linux on ARM64 or x64 (Intel macOS is unsupported)
- Node.js 22.19+ and `tar`
- `curl` for the HTTPS convenience command

Review [`scripts/bootstrap.sh`](scripts/bootstrap.sh), then choose one explicit mode.

**Side-by-side (default):** installs `pi-wait-for-user` and never claims `pi`.

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.11/install.sh | sh
```

**Managed Installation:** additionally claims `pi` through the manager-owned `$HOME/.local/bin` entrypoint.

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.11/install.sh | sh -s -- --manage-pi
```

Use `--bin-dir <path>` to select another launcher directory. The installer never edits shell startup files. If that directory loses PATH resolution, enablement exits nonzero and prints the exact PATH and `hash -r` remediation; rerunning converges safely. An existing Stock Pi is recorded and shadowed, never moved, copied, changed, or deleted. A foreign `pi` or `pi-wait-for-user` launcher is a hard error.

The bootstrap rejects unsupported platforms—including Intel macOS—before any metadata or payload download. On a supported platform, it pins the production root public key, verifies root-signed trust metadata and the delegated signatures on the Release Channel and Release Manifest, then downloads and verifies the exact Manager Release and platform Downstream Release payloads before executing them. The HTTPS-fetched script is itself the initial trust event; it cannot authenticate its own bytes.

Existing Legacy Downstream Installations are adopted only when every payload path, mode, size, and digest matches the signed manifest. Otherwise the manager installs fresh and prints cleanup guidance without deleting the legacy directory.

Windows x64 and ARM64 archives remain manual, side-by-side downloads pending the managed Windows follow-up.

## Use

Start it in any project just like Pi:

```bash
cd /path/to/project
pi-wait-for-user
```

The bundled Question Tool loads automatically. At startup, Pi reports it as:

```text
[Extensions]
  question-tool.ts
```

Its model-facing tool name is **`question`**. Ask the model to use the `question` tool when it needs one or more blocking multiple-choice questions with a custom-answer option. `/deferred` reopens a dismissed Interaction Request, `/deferred inspect` opens core recovery, and `/q` or `Alt+Q` remain conveniences.

Pi uses its normal authentication and session directories, so existing `/login` credentials and sessions remain available.

Useful checks:

```bash
pi-wait-for-user --version       # 0.81.1
pi-wait-for-user conformance     # Deferred conformance passed (8/8)
```

See the [Question Tool guide](packages/question-tool/README.md) for interaction behavior and the typed SDK/RPC outcome seam.

## Independently checked first use

The checksum/attestation-first path verifies the bootstrap before executing it:

```bash
tag=pi-v0.81.1-patch.11
source=$(gh api "repos/taylorrowser/pi-wait-for-user/commits/$tag" --jq .sha)
gh release download "$tag" --pattern install.sh --pattern SHA256SUMS
grep ' install.sh$' SHA256SUMS | shasum -a 256 -c -       # macOS
# or: grep ' install.sh$' SHA256SUMS | sha256sum --check   # Linux
gh attestation verify install.sh \
  --repo taylorrowser/pi-wait-for-user \
  --signer-workflow taylorrowser/pi-wait-for-user/.github/workflows/release.yml \
  --source-digest "$source"
```

Inspect `install.sh`; confirm its embedded root key has the separately published SPKI fingerprint in [`releases/root-public-key.sha256`](releases/root-public-key.sha256), then run `sh install.sh` or `sh install.sh --manage-pi`. `SHA256SUMS` is a generated convenience projection; the attestation and independently checked fingerprint establish first-use evidence. Subsequent Managed Updates use the pinned root/delegated-key chain.

## Managed lifecycle

```bash
pi managed status                 # identities, compatibility, Channel, hold, Patch Lag, Stock Pi
pi update                         # synchronous signed Managed Update
pi managed verify --all           # signatures, receipts, payloads, smoke, conformance
pi managed verify --provenance    # plus online GitHub provenance audit
pi managed stock -- --version     # warn, recheck, then execute recorded Stock Pi
pi managed rollback               # previous verified local Activation; never downloads
pi managed rollback --to <id>     # another installed verified Downstream Release
pi managed unhold                 # clear the exact-release Update Hold
pi managed recover --previous     # stage-0 recovery when active content is corrupt
pi managed disable                # remove only the owned pi entrypoint
pi managed uninstall              # remove all and only receipt-proven manager state
```

A compatible patch-only release is an update even when upstream Pi stays at the same version. A compatible upstream rebase follows the same signed Activation path. **Patch Lag** means upstream is newer but no compatible Downstream Release exists: `pi update` succeeds without changing the verified Activation and reports both identities. Failed signatures, digests, identities, platform checks, smoke, or conformance leave the current Activation selected.

Rollback warns that newer sessions may reject or reconstruct as unavailable and records an Update Hold only for the release being left. Explicit update retries that release; a later release remains visible. Normal launch never silently falls through to the previous pair or Stock Pi. Disablement returns command resolution to Stock Pi when present. Uninstall preserves Stock Pi and all shared Pi settings, credentials, packages, sessions, and Agent Threads; ownership mismatches fail without deletion.

Routine release-key rotation/revocation and the public fingerprint are documented in [`docs/release/signing-keys.md`](docs/release/signing-keys.md). Suspected root compromise requires a reviewed new bootstrap; remotely signed metadata cannot repair that trust boundary. See [`docs/release/managed-runtime.md`](docs/release/managed-runtime.md) for recovery details and [`docs/release/production-signing-runbook.md`](docs/release/production-signing-runbook.md) for provenance and publication auditing.

## Source-build fallback

The source-build path is explicitly **unmanaged and side-by-side**. It requires Node.js 22.19+, Git, and npm:

```bash
gh release download pi-v0.81.1-patch.11 --pattern 'pi-wait-for-user-pi-v0.81.1-patch.11.tgz'
tar -xzf pi-wait-for-user-pi-v0.81.1-patch.11.tgz
node package/scripts/install.mjs install
```

It never participates in Command Ownership or the signed publisher-built Activation flow.

## Exact release identity

One root-authorized, signed [Release Channel](releases/README.md) selects the supported signed Release Manifest. The manifest records:

- exact upstream repository, tag, commit, and lockstep package version;
- every ordered patch path, digest, and size;
- exact Question Tool, session, protocol, handler, and schema compatibility;
- compatible Manager Release identity and artifacts;
- every platform archive plus its complete extracted-file inventory, digests, sizes, and modes;
- required release-gate results; and
- verified GitHub repository, workflow, source commit, and artifact provenance.

`node scripts/release.mjs verify` fails if any pinned build input, package version, or shell identity changes. `artifact-manifest.json`, `SHA256SUMS`, archive metadata, receipts, and the temporary `active.json` compatibility output are generated projections—not independent identity authorities. Unknown schemas, unauthorized/expired keys, invalid signatures, digest drift, and Channel replay fail closed.

## Maintainer workflow

The tag workflow:

1. runs the complete release gate, including managed state-machine and interruption scenarios, against a fresh exact source;
2. uses Pi's upstream Bun cross-compilation path to build macOS Apple Silicon, Linux ARM64/x64, and Windows ARM64/x64 binaries;
3. packages the exact Manager Release, Question Tool, bootstrap, gate report, and each platform Downstream Release payload;
4. signs the generated manifest with public fixture authority, then runs the production receipt boundary against workspace-relative, absolute, missing, and malformed manifest paths and preserves its machine-readable preflight report;
5. smoke-tests version, public conformance, model loading, and Question Tool payload presence on macOS Apple Silicon and Linux ARM64/x64, plus interactive Question Tool loading on Linux x64;
6. verifies GitHub provenance for every payload and exact source/workflow identity;
7. signs the complete Release Manifest and monotonic Release Channel;
8. generates checksums, archive metadata, compatibility output, and the exact macOS Apple Silicon/Linux receipt inventory through the preflighted boundary; and
9. attests and verifies every publishable artifact before publishing one immutable GitHub release.

The release package also contains the local `manager-v2` Managed Installation components: the stable stage-0 dispatcher, atomic Activation engine, immutable pair receipts, lifecycle lock, process leases, recovery/disable operations, layered verification, macOS/Linux Command Ownership, patch-aware Managed Update discovery/routing, local rollback and Update Holds, pinned/live-leased retention and prune, and receipt-safe uninstall. Managed Installations use signed Channel sequence plus exact Downstream Release identity, reserve upstream's latest-version endpoint for Patch Lag, intercept every self-inclusive `pi update` form, and expose `pi managed status`. Lifecycle controls include `pi managed rollback [--to <release-id>]`, `unhold`, `pin [release-id]`, `unpin [release-id]`, `prune`, `disable`, and `uninstall`. See [`docs/release/managed-runtime.md`](docs/release/managed-runtime.md).

For local source verification:

```bash
npm test
node scripts/release-gate.mjs
```

The gate covers the legacy 22-probe journal harness, all patched Pi tests, public conformance, Question Tool typechecking, and Question Tool integration/package tests. Any failed required stage prevents bundling.

### Selected and archived patch policy

Exactly one release is selected by the signed Channel. A newer release gets a new release ID, tag, signed manifest, higher Channel sequence, report, and assets. Promotion never edits or replaces an older release directory, tag, manifest, report, checksum file, provenance attestation, or downloadable artifact.

Older releases are **archived**, not supported. They remain reproducible and downloadable for their pinned Pi source but receive no rebases, feature updates, or retroactive fixes.

No Depot configuration is currently required. GitHub-hosted runners and Bun's cross-compilation support build all supported target binaries in one release job.
