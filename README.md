# Pi Wait for User

A maintained downstream Pi release that can stop an Agent Thread for durable human input, survive complete process teardown, and continue through an explicit Response, Interruption, Cancellation, resume, or abandonment path.

The active release is **`pi-v0.81.1-patch.1`**. It combines:

- the exact upstream Pi `v0.81.1` source at commit `20be4b18d4c57487f8993d2762bace129f0cf7c6`;
- the ten ordered durable-deferral patches in [`patches/active`](patches/active); and
- the independently versioned Question Tool `@taylorrowser/pi-question-tool@0.1.0`.

## Install

### Requirements

- macOS or Linux
- Node.js 22.19 or newer
- Git, npm, curl, and tar
- enough disk space to build Pi from its pinned source

The installer builds in a versioned user-data directory and creates a separate `pi-wait-for-user` command. It does **not** replace an existing `pi` command, and it does not modify Pi settings, credentials, or sessions in `~/.pi/agent`.

### Recommended one-command install

Review [`scripts/bootstrap.sh`](scripts/bootstrap.sh), then run:

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.1/install.sh | sh
```

The bootstrap downloads the release bundle and `SHA256SUMS`, verifies the bundle, and runs the transactional installer. The installer then:

1. verifies the immutable release manifest and passing release-candidate report;
2. clones exactly Pi `v0.81.1` and refuses a repository, tag, commit, or package-version mismatch;
3. applies all patches only after the complete series passes preflight;
4. installs dependencies and builds Pi;
5. runs the public 8/8 deferred conformance suite;
6. installs the exact Question Tool source beside Pi; and
7. creates `~/.local/bin/pi-wait-for-user`.

If `~/.local/bin` is not on `PATH`, the installer prints the exact directory to add.

### Manual, checksum-first install

Download these assets from the [active GitHub release](https://github.com/taylorrowser/pi-wait-for-user/releases/tag/pi-v0.81.1-patch.1):

- `pi-wait-for-user-pi-v0.81.1-patch.1.tgz`
- `SHA256SUMS`

Then verify and install:

```bash
grep 'pi-wait-for-user-pi-v0.81.1-patch.1.tgz$' SHA256SUMS | sha256sum --check # Linux
# or: grep 'pi-wait-for-user-pi-v0.81.1-patch.1.tgz$' SHA256SUMS | shasum -a 256 -c - # macOS

tar -xzf pi-wait-for-user-pi-v0.81.1-patch.1.tgz
node package/scripts/install.mjs install
```

Advanced users can build from an existing pristine checkout of the exact upstream pin:

```bash
node package/scripts/install.mjs install --source /path/to/pi-v0.81.1
```

The checkout still must have the exact origin, tag, commit, package versions, and clean tracked state.

## Use

Start it in any project just like Pi:

```bash
cd /path/to/project
pi-wait-for-user
```

The bundled Question Tool loads automatically. Pi uses its normal authentication and session directories, so existing `/login` credentials and sessions remain available. Run `question` through the model as usual; a durable Interaction Request can be dismissed and reopened with `/q` or `Alt+Q` without losing its lifecycle.

Useful checks:

```bash
pi-wait-for-user --version       # 0.81.1
pi-wait-for-user conformance     # Deferred conformance passed (8/8)
```

See the [Question Tool guide](packages/question-tool/README.md) for interaction behavior and the typed SDK/RPC outcome seam.

## Verify, uninstall, or roll back

The same small bootstrap can invoke release management without trusting whatever is currently on `PATH`:

```bash
# Verify the installed source identity and start the version check
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.1/install.sh | sh -s -- verify

# Remove this release and its launcher
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.1/install.sh | sh -s -- uninstall
```

Uninstall leaves `~/.pi/agent` untouched. It also leaves any separately installed upstream `pi` command untouched.

Releases install into separate versioned directories. To roll back after a future release, download the older release's `install.sh` and run its `activate` action. The old artifact, manifest, and report remain unchanged and downloadable:

```bash
curl -fsSL OLD_RELEASE_INSTALL_URL | sh -s -- activate
```

## Exact release identity

[`releases/active.json`](releases/active.json) points to the one supported active target. Its immutable release directory records:

- exact upstream repository, tag, commit, and lockstep package version;
- every ordered patch path and SHA-256;
- exact Question Tool package, protocol, handler, and schema versions;
- the required fixture inventory; and
- the completed release-candidate report.

`node scripts/release.mjs verify` fails if any pinned input changes. Release assets include their own `artifact-manifest.json` and `SHA256SUMS`.

## Maintainer workflow

Run the complete release gate from a clean checkout:

```bash
npm test
node scripts/release-gate.mjs
node scripts/release.mjs bundle dist/pi-v0.81.1-patch.1
```

The gate prepares a fresh `.work/pi-v0.81.1`, then checks the exact patch, Pi typechecking/build/full suite, the 22-probe legacy journal harness, public conformance, and the real Question Tool typecheck/integration/package suite. Its machine-readable report maps the required legacy, markerless, deferred, ready, partial, complete, unavailable, incompatible-version, compaction, branch, queue, abandonment, RPC, JSON, print, TUI, and Question Tool fixture categories. Any failed stage exits nonzero and prevents bundling.

The tag workflow in [`.github/workflows/release.yml`](.github/workflows/release.yml) repeats this gate, uploads the bundle as a workflow artifact, attests its provenance, and publishes a GitHub release only for the exact active tag.

### Active and archived patch policy

Exactly one release is active. A newer release gets a new release ID, tag, manifest directory, report, and assets. Promotion changes only `releases/active.json`; it never edits or replaces an older release directory, tag, report, checksum file, or downloadable artifact.

Older releases are **archived**, not supported. They remain reproducible and downloadable for their exact Pi version, but receive no rebases, feature updates, or retroactive fixes. Fixes ship in the active release unless this policy is explicitly changed.

No Depot configuration is required for the current gate. GitHub-hosted runners are sufficient; npm caching can be added if runtime becomes material. Publishing uses the repository `GITHUB_TOKEN` only. Enable GitHub's immutable-releases setting so published tags and assets cannot be changed after release.
