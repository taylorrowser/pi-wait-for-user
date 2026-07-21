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

## Prepare the downstream workspace

Requires Git and Node.js 22.19 or newer.

```bash
./scripts/pi-patch.mjs prepare .work/pi-v0.81.1
```

`prepare` clones the pinned tag into a temporary sibling directory, verifies its
identity, applies the complete ordered patch series in a disposable preflight
clone, applies all `patches/active/*.patch` in lexicographic order, and only then
moves the prepared workspace to the requested path. On failure, the temporary clone is removed and
the destination remains absent.

To apply the same patch set to an existing clean checkout:

```bash
./scripts/pi-patch.mjs apply /path/to/pi
```

A version, source, tag, commit, package, or cleanliness mismatch fails before
any patch is applied. The full sequential series is preflighted away from the
target, so a later bad patch cannot leave an earlier patch applied there.

## Verify the unmodified baseline

Run this against a clean checkout of the pinned release before active patches
are present:

```bash
./scripts/verify-upstream.mjs .work/pi-v0.81.1
```

Verification uses a temporary home directory so user extensions and npm configuration cannot affect the baseline. It checks identity before dependency installation, then runs:

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
