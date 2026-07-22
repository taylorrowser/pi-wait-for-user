# Pi Wait for User · `pi-v0.81.1-patch.2`

Fast-install release of durable human interactivity for Pi.

## What changed

- Precompiled macOS, Linux, and Windows binaries for ARM64 and x64
- Normal macOS/Linux installation no longer clones Pi or requires Node, npm, Git, model hydration, or local compilation
- Question Tool `0.1.1` uses the clear startup extension label `question-tool.ts`
- Documentation now names the model-facing tool explicitly as `question`
- Exact source-build installation remains available as a fallback

## Install

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.2/install.sh | sh
```

The installer selects and verifies the current platform asset, installs a separate `pi-wait-for-user` command, and leaves upstream Pi plus `~/.pi/agent` data unchanged.

## Verification

The attached `release-candidate.json` is the complete required-gate result. `artifact-manifest.json` and `SHA256SUMS` identify every downloadable source, binary, package, and report asset. GitHub's build-provenance attestation ties those assets to the release workflow.

## Durability boundary

This release guarantees reconstruction after completed session-journal appends and process teardown. It does not add `fsync`, power-loss safety, torn-tail repair, exact-once external tool side effects, or exact-once provider invocation.

## Archive

[`pi-v0.81.1-patch.1`](https://github.com/taylorrowser/pi-wait-for-user/releases/tag/pi-v0.81.1-patch.1) is archived unchanged and remains downloadable. Archived releases receive no retroactive changes.
