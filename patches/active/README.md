# Active downstream patches

This directory is the complete ordered delta from the Pi release pinned in
`upstream/pi.lock.json`. Patch files use zero-padded names and are applied in
lexicographic order, for example `0001-deferred-entry.patch`.

The active series currently contains the durable deferral, Response-resumption,
atomic whole-batch, idempotent recovery, and ordinary/queued user-input
Interruption slices for issues #13 through #16 and #19. It adds the versioned
tool capability, persisted deferred-batch marker, neutral
markerless/deferred/partial/continuation AgentSession snapshot, package-owned
typed Response and Interruption paths, argument-free `resumeDeferred()`,
complete-batch preflight, markerless recovery, malformed-history reporting,
source-ordered append-by-append advancement, pre-marker queue draining, and
post-marker queue rejection for Pi v0.81.1.
