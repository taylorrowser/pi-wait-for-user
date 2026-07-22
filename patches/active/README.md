# Active downstream patches

This directory is the complete ordered delta from the Pi release pinned in
`upstream/pi.lock.json`. Patch files use zero-padded names and are applied in
lexicographic order, for example `0001-deferred-entry.patch`.

The active series currently contains the durable deferral, Response-resumption,
atomic whole-batch, idempotent recovery, unavailable recovery/abandonment,
ordinary/queued user-input Interruption, branch/compaction preservation,
non-TUI projection, extension/TUI presentation, and extension-conformance
slices for issues #13 through #22. It adds the versioned tool capability, the
fail-closed downstream session identity, persisted deferred-batch marker, neutral
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
public resolver contract types, a minimal package-owned example, comprehensive
Pi-style guidance, and the offline `pi conformance` command for Pi v0.81.1.
