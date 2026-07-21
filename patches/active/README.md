# Active downstream patches

This directory is the complete ordered delta from the Pi release pinned in
`upstream/pi.lock.json`. Patch files use zero-padded names and are applied in
lexicographic order, for example `0001-deferred-entry.patch`.

The active series currently contains the durable deferral, Response-resumption,
and atomic whole-batch slices for issues #13 through #15. It adds the versioned
tool capability, persisted deferred-batch marker, neutral markerless/deferred
AgentSession snapshot, package-owned typed Response path, argument-free
`resumeDeferred()`, complete-batch preflight, and source-ordered missing-call
advancement for Pi v0.81.1.
