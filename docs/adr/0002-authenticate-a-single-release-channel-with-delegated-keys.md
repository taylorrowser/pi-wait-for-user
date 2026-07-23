# Authenticate a single release channel with delegated keys

The project uses one signed mutable Release Channel and one complete signed immutable Release Manifest per Downstream Release. A public offline root key pinned by the Managed Dispatcher authorizes expiring release keys; channel sequence numbers prevent replay, and upstream Pi's release feed remains informational only. This adds key custody and rotation work, but makes compatibility and artifact activation independent of GitHub/TLS compromise while allowing routine signing keys to be revoked without replacing the trust root.

GitHub provenance is mandatory at release promotion and recorded in the signed manifest, while client-side provenance re-verification is an optional online audit. Suspected root compromise requires a reviewed re-bootstrap because a chain signed only by the compromised root cannot safely repair itself.
