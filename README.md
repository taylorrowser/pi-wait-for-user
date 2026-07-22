# Pi Wait for User

A maintained downstream Pi release that can stop an Agent Thread for durable human input, survive complete process teardown, and continue through an explicit Response, Interruption, Cancellation, resume, or abandonment path.

The active release is **`pi-v0.81.1-patch.5`**. It combines:

- the exact upstream Pi `v0.81.1` source at commit `20be4b18d4c57487f8993d2762bace129f0cf7c6`;
- the twelve ordered durable-deferral patches in [`patches/active`](patches/active); and
- the independently versioned Question Tool `@taylorrowser/pi-question-tool@0.1.3`.

## Fast install

### Requirements

- macOS or Linux, on ARM64 or x64
- `curl` and `tar`

The normal installer downloads a precompiled, checksummed binary for the current platform. It does **not** clone Pi, run npm, hydrate model data, compile source, require Node.js, or replace an existing `pi` command.

Review [`scripts/bootstrap.sh`](scripts/bootstrap.sh), then run:

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.5/install.sh | sh
```

The installer verifies `SHA256SUMS`, installs into a versioned user-data directory, runs the public 8/8 deferred conformance check, and creates `~/.local/bin/pi-wait-for-user`. If that directory is not on `PATH`, it prints the exact directory to add.

Windows x64 and ARM64 binaries are attached to the release for manual use; the one-command installer currently targets macOS and Linux.

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

Its model-facing tool name is **`question`**. Ask the model to use the `question` tool when it needs one or more blocking multiple-choice questions with a custom-answer option. `/q` and `Alt+Q` reopen a dismissed Interaction Request.

Pi uses its normal authentication and session directories, so existing `/login` credentials and sessions remain available.

Useful checks:

```bash
pi-wait-for-user --version       # 0.81.1
pi-wait-for-user conformance     # Deferred conformance passed (8/8)
```

See the [Question Tool guide](packages/question-tool/README.md) for interaction behavior and the typed SDK/RPC outcome seam.

## Checksum-first manual install

Download `SHA256SUMS` and the matching asset from the [active GitHub release](https://github.com/taylorrowser/pi-wait-for-user/releases/tag/pi-v0.81.1-patch.5):

| Platform | Asset |
| --- | --- |
| Apple Silicon | `pi-wait-for-user-darwin-arm64.tar.gz` |
| Intel macOS | `pi-wait-for-user-darwin-x64.tar.gz` |
| Linux x64 | `pi-wait-for-user-linux-x64.tar.gz` |
| Linux ARM64 | `pi-wait-for-user-linux-arm64.tar.gz` |

Verify the selected asset, extract it, and run its installer:

```bash
asset=pi-wait-for-user-darwin-arm64.tar.gz
grep "$asset$" SHA256SUMS | shasum -a 256 -c - # macOS
# or: grep "$asset$" SHA256SUMS | sha256sum --check # Linux

tar -xzf "$asset"
sh pi-wait-for-user/install.sh install
```

## Verify, uninstall, or roll back

The release bootstrap can manage the exact version without relying on whichever executable is currently on `PATH`:

```bash
# Verify
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.5/install.sh | sh -s -- verify

# Uninstall this release
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.5/install.sh | sh -s -- uninstall
```

Uninstall leaves `~/.pi/agent` and any upstream `pi` installation untouched.

Releases install into separate versioned directories. To roll back after a future release, use the older immutable release's `install.sh` with `activate`. Archived [`pi-v0.81.1-patch.1`](https://github.com/taylorrowser/pi-wait-for-user/releases/tag/pi-v0.81.1-patch.1) remains unchanged and downloadable.

## Source-build fallback

Use this only when a prebuilt binary is unsuitable. It requires Node.js 22.19+, Git, and npm, and performs the slower exact-source clone and build:

```bash
gh release download pi-v0.81.1-patch.5 \
  --pattern 'pi-wait-for-user-pi-v0.81.1-patch.5.tgz'
tar -xzf pi-wait-for-user-pi-v0.81.1-patch.5.tgz
node package/scripts/install.mjs install
```

The source installer verifies the immutable release manifest and report, clones exactly Pi `v0.81.1`, preflights every patch, builds, runs conformance, and installs a separate launcher.

## Exact release identity

[`releases/active.json`](releases/active.json) points to the one supported active target. Its immutable release directory records:

- exact upstream repository, tag, commit, and lockstep package version;
- every ordered patch path and SHA-256;
- exact Question Tool package, protocol, handler, and schema versions;
- the required fixture inventory; and
- the completed release-candidate report.

`node scripts/release.mjs verify` fails if any pinned input changes. Every source, platform binary, Question Tool package, report, and manifest is covered by the published `SHA256SUMS` and GitHub provenance attestation.

## Maintainer workflow

The tag workflow:

1. runs the complete 12-stage release gate against a fresh exact source;
2. uses Pi's upstream Bun cross-compilation path to build macOS, Linux, and Windows binaries for ARM64 and x64;
3. packages the exact Question Tool beside each binary;
4. smoke-tests the Linux binary, conformance command, and package payload;
5. builds all checksummed source and binary assets; and
6. publishes one immutable GitHub release.

For local source verification:

```bash
npm test
node scripts/release-gate.mjs
```

The gate covers the legacy 22-probe journal harness, all patched Pi tests, public conformance, Question Tool typechecking, and Question Tool integration/package tests. Any failed required stage prevents bundling.

### Active and archived patch policy

Exactly one release is active. A newer release gets a new release ID, tag, manifest directory, report, and assets. Promotion changes only `releases/active.json`; it never edits or replaces an older release directory, tag, report, checksum file, or downloadable artifact.

Older releases are **archived**, not supported. They remain reproducible and downloadable for their pinned Pi source but receive no rebases, feature updates, or retroactive fixes.

No Depot configuration is currently required. GitHub-hosted runners and Bun's cross-compilation support build all target binaries in one release job.
