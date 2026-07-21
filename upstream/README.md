# Upstream identity

`pi.lock.json` is the authoritative active-target identity. The patch tooling
accepts only the exact repository, tag, commit, and lockstep package identities
recorded there. Moving to another Pi release requires an explicit lock update
and a fresh unmodified baseline run.
