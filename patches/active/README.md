# Active downstream patches

This directory is the complete ordered delta from the Pi release pinned in
`upstream/pi.lock.json`. Patch files use zero-padded names and are applied in
lexicographic order, for example `0001-deferred-entry.patch`.

The active series currently contains the durable single-tool deferral and
Response-resumption slices for issues #13 and #14. It adds the versioned tool
capability, persisted deferred-batch marker, neutral markerless/deferred
AgentSession snapshot, package-owned typed Response path, and argument-free
`resumeDeferred()` operation for Pi v0.81.1.
