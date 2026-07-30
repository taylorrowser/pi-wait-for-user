# ADR 0001: Retain source content only after the PorcuPi handoff

## Status

Accepted after PorcuPi v0.1.0 publication and exact-revision acceptance.

## Context

`pi-wait-for-user` originally owned Patch source and the Question Tool alongside source builds, launchers, Managed Installation state, update/channel/signing machinery, retention, Windows lifecycle behavior, and published payload projections. PorcuPi was created to own the smaller general macOS/Linux composition and lifecycle boundary without copying this repository's content.

PorcuPi v0.1.0 consumes `pi-wait-for-user` as an exact Git Source Repository. Its released revision passed the real-source public-process gate on macOS arm64 and Linux x64, both with and without Stock Pi. PorcuPi independently covers failed builds, interruption recovery, atomic activation, fail-closed launch, verification, rollback, lifecycle locking, leases, collision-safe optional `pi` ownership, receipt-proven cleanup, and conservative uninstall.

Keeping the old machinery active on this default branch would create a second lifecycle authority and preserve release/signing/channel abstractions outside the accepted product boundary. Existing installations still need their own historical manager to uninstall safely.

## Decision

The default branch owns only:

- the regular Patch files under `patches/active/` and content documentation/tests;
- the independently versioned `@taylorrowser/pi-question-tool` ordinary Pi package and its tests/documentation;
- root `porcupi.json` metadata limited to Patch display names and exact Pi Base version/commit compatibility; and
- repository guidance that sends current composition/lifecycle users to PorcuPi.

PorcuPi owns all current composition and lifecycle behavior. Pi owns installation and loading of the Question Tool as an ordinary package. There is no dependency graph, automatic Patch/Question Tool coupling, copied content, special bundling, or second active manager.

The default branch removes source-build installer/launcher code, manager/dispatcher/runtime/update code, signing/channel/provenance/publication tooling and projections, executable Pi Base lock, manager lifecycle tests, legacy adoption, broad retention, and Windows manager machinery.

Historical Git tags and published GitHub Releases are not changed or deleted. An existing user must invoke the old installed manager's own `pi managed uninstall` or `pi-wait-for-user managed uninstall` before installing PorcuPi. PorcuPi does not adopt legacy state or payloads.

## Consequences

- Exact source commits remain usable by PorcuPi without moving or copying Patch or Question Tool bytes.
- Current default-branch tests validate source content rather than duplicating lifecycle acceptance.
- Full composition and package-install behavior is qualified at PorcuPi's public external-process seam.
- Historical release recovery remains available from immutable tags and GitHub Releases, but no old manager code remains active on the default branch.
- Future Patch compatibility changes use only the accepted narrow metadata schema; executable source metadata and release-channel machinery are not reintroduced.
