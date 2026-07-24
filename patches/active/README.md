# Active downstream patches

This directory is the complete ordered delta from the Pi release pinned in
`upstream/pi.lock.json`. Patch files use zero-padded names and are applied in
lexicographic order, for example `0001-deferred-entry.patch`. The active release
manifest pins every filename and SHA-256; changing any patch requires a new
release ID and a fresh release-candidate report.

The active series currently contains the durable deferral, Response-resumption,
atomic whole-batch, idempotent recovery, unavailable recovery/abandonment,
ordinary/queued user-input Interruption, branch/compaction preservation,
non-TUI projection, extension/TUI presentation, extension conformance, the live
unavailable-resolver fix, the restart-safe reference-presenter fix, explicit
eager session-header compatibility documentation, the core-owned deferred
re-entry affordance, and the retired NVIDIA model-catalog correction for issues #13 through #22, #43 through #45, #49, and #58. It adds the
versioned tool capability, fail-closed downstream session identity, typed
live-path resolver failures, persisted deferred-batch marker, neutral
markerless/deferred/partial/continuation AgentSession snapshot, package-owned
typed Response, Interruption, and Cancellation paths, argument-free
`resumeDeferred()` and `abandonDeferred()`, exact capability discovery,
privacy-safe compatibility reasons, complete-batch preflight, markerless
recovery, malformed-history reporting, source-ordered append-by-append
advancement, core fallback abandonment, pre-marker queue draining, post-marker
queue rejection, active-branch lifecycle reconstruction, session-local request
identity reuse, exact boundary copying, unresolved-owner compaction pinning,
complete deferred-state events, RPC inspection/advancement/error contracts,
privacy-safe JSON/print Waiting State output, extension-facing neutral snapshots
and scheduled lifecycle operations, package-owned deferred presenters, a
generic interactive deferred inspector, fail-fast capability registration,
public resolver contract types, a minimal package-owned example with restart
reconstruction coverage, an ordinary-session header regression fixture,
core-routed `/deferred` and `/deferred inspect` presentation, privacy-safe
package summaries, comprehensive Pi-style guidance, and the offline `pi
conformance` command for Pi v0.81.1.

The durable Question Tool is intentionally not another Pi patch. It is the
independently versioned package under [`packages/question-tool`](../../packages/question-tool),
loaded on top of this complete active series.
