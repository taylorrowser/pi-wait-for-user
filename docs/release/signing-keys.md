# Release signing and bootstrap trust

The Managed Installation has two signing roles:

- a human-custodied **root key** signs versioned `release-trust` metadata;
- short-lived online **release keys** delegated by that metadata sign each Release Channel and Release Manifest.

The dispatcher or reviewed bootstrap pins the root public key. GitHub, TLS, the repository branch, and the upstream Pi feed are transport or informational inputs; none are release authorities.

No production private key belongs in this repository, a release archive, an Actions artifact, a log, or a fixture. Keys under `test/fixtures/release-keys/` are intentionally public test material and have no production authority.

The executable division of agent, human-approval, and human-only steps is in [`production-signing-runbook.md`](production-signing-runbook.md). That runbook also covers protected-Environment configuration, clean verification, promotion PR creation, authorized agent merge, and partial-publication recovery.

Clients persist two anti-replay checkpoints. Accepted trust state contains the highest root-signed trust version and the canonical complete-envelope digest; lower versions and non-identical equal-version retries fail closed. Accepted Channel state contains the highest sequence, selected manifest identity, and canonical complete-envelope digest; lower sequences and non-identical equal-sequence retries fail closed. These checkpoints are local state, never an independent release authority.

## Bootstrap boundary

A fast `curl | sh` installation is an initial trust decision in the bytes returned over HTTPS. It does not authenticate itself. The reviewable bootstrap must pin the root public key and verify root-signed trust metadata before accepting a Release Channel, Release Manifest, or payload.

For an independently checked first install:

1. download the bootstrap and its published checksum or GitHub build-provenance attestation without executing it;
2. verify the checksum/attestation and repository/workflow identity out of band;
3. inspect that the embedded root key fingerprint matches a separately published fingerprint; and
4. execute the reviewed local file.

After bootstrap, managed updates use the pinned root and delegated release signatures. A new root cannot become trusted merely because remotely fetched metadata names it.

## Initial key ceremony

The current sole-maintainer policy permits the production ceremony on the FileVault-protected maintainer workstation with one human operator. This is weaker than witnessed offline custody and is accepted explicitly in ADR 0003. The private directory must remain outside the repository and agent-controlled paths; no agent may execute private-key commands or inspect their files. Use an Ed25519 implementation from the approved operations environment. The following names are placeholders, not commands to paste into CI:

```text
root key id:    root-YYYY-N
release key id: release-YYYY-N
```

1. Generate the root key in a human-operated private directory and make encrypted, access-controlled backups according to the project's recovery policy.
2. Export only the root public key and record its SHA-256 fingerprint through independent channels.
3. Generate the routine release key in the restricted signing environment.
4. Create `release-trust` schema v1 with a strictly increasing version, an expiry, the authenticated Channel URL, and the release public key plus its expiry and revocation state.
5. Use the fixture-tested `release-metadata.mjs sign-trust` command from the human's local terminal to construct and sign the canonical `signed` object with the root key.
6. Verify the trust document against the independently recorded root public key before publication.
7. Provision the release private key through the human-controlled secret path described by the release runbook; never echo it.

Keep root and release-key audit records: key IDs, public-key fingerprints, operator, any witnesses, creation time, authorization window, and destruction/revocation time.

## Routine release-key rotation

Rotate before expiry:

1. generate a new release key in the restricted signing environment;
2. add its public key to a new trust-metadata version and choose a bounded expiry;
3. optionally retain the old key during a short overlap;
4. root-sign and independently verify the new trust document;
5. publish it before signing a Channel with the new key; and
6. after clients have had an overlap window, publish another higher trust version marking the old key revoked, then destroy its private material.

Clients reject an unknown, expired, or revoked signing key. They also reject expired trust or Channel metadata. An unexpired, already installed Activation remains usable when refresh fails.

## Routine revocation

For loss of access, suspected exposure, or operator departure:

1. stop release promotion;
2. use the human-custodied root to publish a higher trust version with the key's `revoked` flag set;
3. delegate a new release key if publication must continue;
4. re-sign the next Channel and every new Release Manifest with the new key;
5. preserve the old public metadata for audit, but destroy recoverable copies of the old private key; and
6. investigate every manifest and Channel sequence signed during the exposure window.

Never lower a Channel sequence to undo a release. Promote a new manifest at a higher sequence.

## Normal root rotation

Root rotation requires a dispatcher/bootstrap version that understands both roots.

1. Generate the new root in the custody environment selected by the then-current reviewed policy and distribute its public fingerprint independently.
2. Produce equivalent transition metadata signed by both the old and new roots.
3. Release a compatible dispatcher that pins both roots and requires the documented transition.
4. Allow an adoption period, then publish trust metadata rooted only in the new key through a dispatcher release that already pins it.
5. Retire and destroy the old root according to the reviewed custody policy.

A client too old to understand the transition fails closed and directs the user to a reviewed bootstrap; it must not guess at an unknown schema.

## Compromise recovery

### Release key suspected compromised

Follow routine revocation. Because the root remains trusted, a higher root-signed trust version can revoke the release key. Audit Channel sequences for equivocation and publish a higher sequence selecting a known-good new manifest.

### Root key suspected compromised

Stop all promotion. A chain signed only by the suspected root cannot repair trust: an attacker holding that root could create the same chain. Recovery requires a new, explicitly reviewed bootstrap/dispatcher carrying a newly generated root public key, independent fingerprint publication, and direct user or administrator action. Do not label this as automatic rotation.

## Release ceremony

For each promotion:

1. build immutable payload artifacts from the exact source commit;
2. run every declared release gate;
3. verify GitHub build provenance for **every payload artifact**, requiring `taylorrowser/pi-wait-for-user` and `.github/workflows/release.yml`;
4. record each artifact name/digest plus that repository, workflow, and source commit in the Release Manifest;
5. sign and verify the complete immutable manifest;
6. generate `artifact-manifest.json`, `SHA256SUMS`, archive metadata, receipts, and compatibility metadata from that manifest, and verify package, installer, shell, and release-documentation identities against it;
7. create a Channel with a higher sequence, or canonical-envelope-identically retry the already accepted equal sequence;
8. sign and verify the Channel, including its manifest digest; and
9. publish the Channel atomically only after immutable artifacts and manifest are available.

The release job must fail on a missing subject, repository/workflow mismatch, source-commit mismatch, signature failure, projection drift, or sequence replay.
