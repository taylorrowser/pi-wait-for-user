# Active downstream patches

This directory is the complete ordered delta from the Pi release pinned in
`upstream/pi.lock.json`. Patch files use zero-padded names and are applied in
lexicographic order, for example `0001-deferred-entry.patch`.

The active series currently contains the durable deferral, Response-resumption,
atomic whole-batch, idempotent recovery, ordinary/queued user-input
Interruption, and branch/compaction preservation slices for issues #13 through
#16, #18, and #19. It adds the versioned tool capability, persisted
deferred-batch marker, neutral markerless/deferred/partial/continuation
AgentSession snapshot, package-owned typed Response and Interruption paths,
argument-free `resumeDeferred()`, complete-batch preflight, markerless recovery,
malformed-history reporting, source-ordered append-by-append advancement,
pre-marker queue draining, post-marker queue rejection, active-branch lifecycle
reconstruction, session-local request identity reuse, exact boundary copying,
and unresolved-owner compaction pinning for Pi v0.81.1.
