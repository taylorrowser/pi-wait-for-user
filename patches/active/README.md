# Active Patch source

This directory contains the 20 declarative Git Patches maintained by `pi-wait-for-user`. The files remain in their established zero-padded lexical order and are compatible with exact Pi Base `v0.81.1` at commit `20be4b18d4c57487f8993d2762bace129f0cf7c6`.

The root [`porcupi.json`](../../porcupi.json) supplies only display text and exact Pi Base compatibility. [PorcuPi](https://github.com/taylorrowser/PorcuPi) discovers the regular Patch files in place, binds their exact source commit/path/SHA-256 identities, orders selected Patches by canonical Source Repository and source-relative path, and owns preflight, composition, activation, verification, rollback, leases, cleanup, and uninstall. This repository does not apply, build, publish, activate, or update the series.

The series adds durable deferral, Response resumption, atomic whole-batch behavior, idempotent recovery, unavailable recovery/abandonment, user-input Interruption, branch/compaction preservation, headless and extension/TUI projections, extension conformance, the core deferred-work re-entry affordance, and the model/build corrections required by the supported Pi Base.

The Question Tool is not a Patch or Patch dependency. It remains the independently versioned ordinary Pi package under [`packages/question-tool`](../../packages/question-tool) and must be installed through Pi's package lifecycle.
