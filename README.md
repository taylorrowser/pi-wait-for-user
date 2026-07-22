# Pi Wait for User

A maintained downstream patch set for durable human interactivity in Pi. This
repository keeps Pi itself out of tree: one exact upstream release is prepared
into an ignored workspace and changed only by reviewable patch files.

## Active target

The machine-readable pin is [`upstream/pi.lock.json`](upstream/pi.lock.json):

- repository: `https://github.com/earendil-works/pi.git`
- release: `v0.81.1`
- commit: `20be4b18d4c57487f8993d2762bace129f0cf7c6`
- lockstep Pi package version: `0.81.1`

The commit, tag, origin URL, package names, and package versions must all match.
A tracked source change is also rejected before patching.

## Durable Question Tool

[`packages/question-tool`](packages/question-tool) is the first independently
versioned consumer of the downstream capability. It records package-owned
Interaction Requests, Responses, Interruptions, and Cancellations around Pi's
neutral Deferred Tool Batch marker. Its accepted TUI
supports supplied choices, one inline custom-answer row, multi-question review,
dismissal, `/q` and `Alt+Q` reopening, and settled history rendering.

The package is loaded separately from the patch:

```bash
.work/pi-v0.81.1/packages/coding-agent/dist/cli.js \
  -e ./packages/question-tool
```

See the [Question Tool README](packages/question-tool/README.md) for its exact
protocol/handler/schema contract, installation, programmatic SDK/RPC outcome
seam, interaction behavior, and development commands.

## Prepare the downstream workspace

Requires Git and Node.js 22.19 or newer.

```bash
./scripts/pi-patch.mjs prepare .work/pi-v0.81.1
```

`prepare` clones the pinned tag into a temporary sibling directory, verifies its
identity, applies the complete ordered patch series in a disposable preflight
clone, applies all `patches/active/*.patch` in lexicographic order, and only then
moves the prepared workspace to the requested path. On failure, the temporary
clone is removed and the destination remains absent.

To apply the same patch set to an existing clean checkout:

```bash
./scripts/pi-patch.mjs apply /path/to/pi
```

A version, source, tag, commit, package, or cleanliness mismatch fails before
any patch is applied. The full sequential series is preflighted away from the
target, so a later bad patch cannot leave an earlier patch applied there.

## Build and install the patched Pi CLI

`prepare` and `apply` patch source; they do not replace the `pi` executable on
your PATH. Build the prepared source and link its coding-agent package into the
currently selected Node installation:

```bash
(
  cd .work/pi-v0.81.1
  npm ci --ignore-scripts
  npm run hydrate:model-data
  npm run build:offline
  cd packages/coding-agent
  npm link
)

pi --version
pi conformance
```

The version must be `0.81.1`, and conformance must finish with `8/8` checks.
`npm link` is intentionally a source-backed installation: the global `pi`
command points into `.work/pi-v0.81.1`, so keep that workspace in place. Run it
under the same Node installation or version-manager environment in which you
want `pi` available.

To restore the published unpatched package later:

```bash
npm unlink --global @earendil-works/pi-coding-agent
npm install --global @earendil-works/pi-coding-agent@0.81.1
```

## Install the Question Tool

From this repository root, persistently install the independently versioned
package into the patched Pi:

```bash
pi install "$(pwd)/packages/question-tool"
pi list
```

`pi list` must show the resolved `packages/question-tool` path. Start `pi`
normally; the `question` tool is then available in every session. To try it
without changing settings, use:

```bash
pi -e "$(pwd)/packages/question-tool"
```

Remove the persistent package with:

```bash
pi remove "$(pwd)/packages/question-tool"
```

The automated installation smoke test performs the link, conformance, package
installation, discovery, and startup flow under isolated npm and Pi directories:

```bash
npm run test:question-tool
```

## Verify the unmodified baseline

Run this against a clean checkout of the pinned release before active patches
are present:

```bash
./scripts/verify-upstream.mjs .work/pi-v0.81.1
```

Verification uses a temporary home directory so user extensions and npm
configuration cannot affect the baseline. It checks identity before dependency
installation, then runs:

1. `npm ci --ignore-scripts`
2. `npm run check`
3. `npm run hydrate:model-data` to fetch the release's generated model artifact
4. `npm run build:offline` using that pinned model data
5. upstream `./test.sh` without API credentials
6. the 22-probe session-journal compatibility harness
7. a final source identity and cleanliness check

The harness writes its versioned report under
`prototype/session-journal-harness/reports/`.

## Maintain the patch delta

Make feature changes only in a prepared Pi workspace. Record reviewable commits
there, then export the ordered series from the pinned commit:

```bash
git -C .work/pi-v0.81.1 switch -c downstream
git -C .work/pi-v0.81.1 format-patch \
  --output-directory="$PWD/patches/active" \
  20be4b18d4c57487f8993d2762bace129f0cf7c6..HEAD
```

Recreate the workspace at a new path to prove the series applies from the clean
pin. Do not vendor the Pi checkout or commit generated build dependencies here.
When the active upstream target changes, update the lock and baseline report in
an explicit compatibility commit; released patch sets are archived rather than
silently retargeted.
