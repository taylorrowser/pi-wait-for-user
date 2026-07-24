# Production signing and Channel publication runbook

This is the resumable operating procedure for issue #58 and later Downstream Releases. A maintainer or a fresh coding agent should be able to recover the current stage from repository and GitHub state alone.

The acceptance checklist in GitHub issue #58 remains authoritative. This runbook does not permit an agent to cross the private-key custody boundary.

## Roles and custody boundary

Each step is marked with its permitted operator:

- **Agent**: may execute with repository/GitHub access.
- **Human approval**: an agent stops and obtains an explicit decision or approval.
- **Human only**: must run in the maintainer-controlled environment; an agent never runs it or receives its private inputs.

An agent must never generate, read, receive, copy, configure, or search by value for a production private key. Never paste a private key, seed, recovery phrase, secret value, or unredacted secret output into chat. The only production secret accepted by Actions is `RELEASE_SIGNING_PRIVATE_KEY`. The offline root private key never enters GitHub, the repository, an agent-controlled temporary file, or a networked ceremony step.

Public keys, SPKI fingerprints, signed public envelopes, signatures, key IDs, validity windows, and redacted success/failure results are safe public outputs.

Public policy is recorded in [`releases/signing-policy.json`](../../releases/signing-policy.json). The initial policy is:

- root key ID `root-2026-1`;
- delegated key ID `release-2026-1`;
- 18 calendar months of trust-metadata validity;
- 180 days of delegated-key validity;
- a maximum 60-day Channel validity window;
- delegated-key rotation 45 days before expiry;
- two offline ceremony reviewers;
- a sole-admin GitHub Environment approval with self-approval permitted; and
- private operational records in an encrypted maintainer vault with an offline encrypted backup.

Changing policy requires a reviewed repository change before the affected ceremony or promotion.

## Stable public files

These names are contractual:

| Repository file | Stable URL | Purpose |
| --- | --- | --- |
| `releases/root-public-key.pem` | raw `main` URL | Pinned production root public key. |
| `releases/root-public-key.sha256` | raw `main` URL | Lowercase SHA-256 of the root's DER-encoded SPKI. |
| `releases/release-trust.json` | raw `main` URL | Root-signed delegated-key authority. |
| `releases/trust-state.json` | raw `main` URL | Highest accepted trust checkpoint used by promotion. |
| `releases/channel.json` | raw `main` URL | Sole mutable release-selection authority. |
| `releases/channel-state.json` | raw `main` URL | Highest accepted Channel checkpoint used by promotion. |

`release-trust.json` and `channel.json` must remain adjacent because managed clients resolve trust beside the prior authenticated Channel URL. The state files prevent the release workflow from publishing a lower or non-identical equal version; they are not independent authorities.

A promotion PR changes all generated stable state in one commit. Merging that commit atomically updates the raw `main` view after immutable release assets are already available.

## Resume from public state

**Agent**

A fresh agent starts with public state discovery; it never asks for a secret to determine progress:

```bash
gh issue view 58 --comments
gh issue view 62 --comments
gh pr list --state all --search 'head:implement/issue-58-production-signing'
gh pr list --state all --json number,state,headRefName,url --jq '.[] | select(.headRefName | startswith("release-promotion/"))'
gh run list --workflow release.yml --limit 20
gh release list --limit 20
git ls-remote --heads origin 'release-promotion/*'
gh api repos/{owner}/{repo}/environments
gh secret list --env production-release
gh variable list --env production-release
```

Use the results to resume at exactly one boundary:

| Public state | Resume action |
| --- | --- |
| Preparation PR open | Continue public review/repair; do not start production signing. |
| Preparation merged, public ceremony files absent | Wait for the human-only ceremony. |
| Public ceremony files on the preparation branch | Run Phase 4 public verification and review. |
| #62 open or no exact candidate approval | Stop before tagging and continue Phase 5. |
| Release run awaiting Environment approval | Show the tag/commit/policy to the human and wait. |
| Immutable release absent after a failed run | Follow the frozen-variable retry procedure. |
| Immutable release present, promotion branch absent | Recover the branch from immutable public release assets. |
| Promotion branch present, PR absent | Verify the branch and create the PR. |
| Promotion PR open | Resume independent verification, review, and CI. |
| Promotion PR green but merge unauthorized | Present evidence and wait for explicit authorization. |
| Promotion PR merged | Verify stable raw bytes, then update #58 and #47. |

Never infer completion merely from a successful workflow run. Verify the immutable release, promotion branch/PR, actual merge commit, and stable raw bytes independently.

## Phase 1: public preparation

**Agent**

1. Fetch `origin` without modifying an unrelated checkout.
2. Work in a dedicated issue worktree based on current `origin/main`.
3. Read issue #58, all comments, the parent #47 map, the managed-installation design, ADR 0002, this runbook, and `signing-keys.md`.
4. Confirm issue #62's live state. Preparation may proceed in parallel, but candidate selection and publication wait for #62 to merge.
5. Run the fixture ceremony and metadata tests:

   ```bash
   node --test test/release-metadata.test.mjs
   npm test
   node scripts/release.mjs verify
   node scripts/release-gate.mjs
   ```

6. Confirm the production workflow has only public root material and the delegated private-key secret. It must not reference a root private key.
7. Open the public-preparation PR, run Standards and Spec reviews from its fixed `origin/main` merge base, and wait for green CI.
8. Merge the reviewed preparation PR only with user authorization. The ceremony uses this merged tooling from an exact `main` commit; its public outputs return through a separate public-trust PR.

## Phase 2: configure the protected GitHub Environment

The Environment name is `production-release`.

**Agent, with repository-administration authorization**

1. Inspect current configuration without requesting secret values:

   ```bash
   gh api repos/{owner}/{repo}/environments
   gh secret list --env production-release
   gh variable list --env production-release
   ```

2. Create or update the Environment's public protection settings, or guide the human through **Settings → Environments → production-release**.
3. Restrict deployment branches/tags to production release tags matching `pi-v*-patch.*`.
4. Configure the sole administrator as a required reviewer and leave “Prevent self-review” disabled, as selected in the public policy. Record a future change to two-person governance as a normal reviewed policy change.

**Human only**

Use the GitHub administrative UI or another maintainer-controlled secret path to create `RELEASE_SIGNING_PRIVATE_KEY`. Do not use an agent-provided shell command and do not reveal the value. Tell the agent only whether configuration succeeded.

**Agent**

Configure only these non-secret Environment variables:

```text
RELEASE_SIGNING_KEY_ID
RELEASE_CHANNEL_SEQUENCE
RELEASE_CHANNEL_EXPIRES
```

For the first publication, `RELEASE_SIGNING_KEY_ID` is `release-2026-1` and `RELEASE_CHANNEL_SEQUENCE` is `1`. Freeze `RELEASE_CHANNEL_EXPIRES` to one exact ISO timestamp approximately 60 days after the planned workflow run. Never change expiry while retrying an equal Channel sequence.

An authorized agent may set public variables without receiving a secret:

```bash
gh variable set RELEASE_SIGNING_KEY_ID --env production-release --body 'release-2026-1'
gh variable set RELEASE_CHANNEL_SEQUENCE --env production-release --body '1'
gh variable set RELEASE_CHANNEL_EXPIRES --env production-release --body 'YYYY-MM-DDTHH:MM:SS.000Z'
```

## Phase 3: offline initial ceremony

See [`signing-keys.md`](signing-keys.md) for custody, backup, rotation, and compromise requirements.

**Human only, witnessed by two reviewers**

1. Generate the Ed25519 root key offline and the delegated Ed25519 key in the restricted signing environment.
2. Store private custody material and private runbooks in the approved encrypted maintainer vault and offline encrypted backup.
3. Export only SPKI public keys.
4. Create a public trust-signing input alongside the delegated public key:

   ```json
   {
     "schemaVersion": 1,
     "type": "release-trust",
     "version": 1,
     "expires": "<ceremony time plus 18 calendar months, ISO UTC>",
     "channelUrl": "https://raw.githubusercontent.com/taylorrowser/pi-wait-for-user/main/releases/channel.json",
     "releaseKeys": [
       {
         "keyId": "release-2026-1",
         "algorithm": "ed25519",
         "publicKeyFile": "release-public.pem",
         "expires": "<ceremony time plus 180 days, ISO UTC>",
         "revoked": false
       }
     ]
   }
   ```

5. In the offline checkout, run the fixture-tested command below with private file paths supplied only inside that environment:

   ```bash
   node scripts/release-metadata.mjs sign-trust \
     --input <public-trust-input.json> \
     --root-key-id root-2026-1 \
     --root-private-key <offline-root-private-key-file> \
     --root-public-key <root-public-key-file> \
     --output <public-output-directory>/release-trust.json
   ```

6. Compute the independently reviewable public fingerprint:

   ```bash
   node scripts/release-metadata.mjs fingerprint \
     --public-key <root-public-key-file> \
     > <public-output-directory>/root-public-key.sha256
   ```

7. Have both reviewers compare the displayed and saved fingerprint over independent public channels and verify the trust envelope offline.
8. Provision the delegated private key in the protected Environment through the human-only path. Do not send it to the agent.

The only files transferred out of the ceremony for repository review are:

```text
root-public-key.pem
root-public-key.sha256
release-trust.json
```

The public trust envelope already contains the delegated public key. Do not transfer a private audit log or private runbook.

## Phase 4: agent verification of public ceremony output

**Agent**

1. Accept only the three public files listed above.
2. Refuse any file containing `PRIVATE KEY`, seed, secret, or recovery material without printing its contents.
3. Place the public files at their contractual repository paths.
4. Verify the fingerprint and trust signature:

   ```bash
   actual=$(node scripts/release-metadata.mjs fingerprint --public-key releases/root-public-key.pem)
   expected=$(tr -d '[:space:]' < releases/root-public-key.sha256)
   test "$actual" = "$expected"

   node scripts/release-metadata.mjs verify-trust \
     --trust releases/release-trust.json \
     --root-key root-2026-1=releases/root-public-key.pem
   ```

5. Inspect only public fields and confirm version `1`, the selected key IDs, validity windows, `revoked: false`, and the exact stable Channel URL.
6. Open a public-trust PR containing only the reviewed public ceremony outputs, run Standards and Spec reviews from its fixed `origin/main` merge base, wait for green CI, and merge only if the user authorizes it.

## Phase 5: select the immutable first Downstream Release

This phase is blocked until #62 is merged.

**Agent**

1. Fetch current `origin/main` and confirm #62 is closed and its PR merge commit is on `main`.
2. Rebase the #58 public work onto current `origin/main`.
3. Propose one unpublished release ID and one exact 40-character source commit on `main`.
4. Confirm no tag or GitHub Release already uses that ID.
5. Run the complete release gate from a clean checkout of that exact commit.
6. Present the release ID, source commit, upstream identity, Manager Release identity, and Channel sequence to the user.

**Human approval**

Explicitly approve the exact release ID and source commit. Approval of a branch name or moving `main` is insufficient.

**Agent, only after approval**

Create and push the exact release tag if the user has authorized tag publication. The tag triggers `.github/workflows/release.yml`.

## Phase 6: protected workflow and immutable publication

The workflow has two jobs:

1. `release-candidate` has no signing secret. It builds, gates, attests, verifies, and uploads an unsigned candidate.
2. `production-release` runs only for a release tag, waits at the `production-release` Environment, receives the delegated secret after approval, fetches trust and replay checkpoints from current `origin/main`, signs metadata, publishes the immutable GitHub Release, and finally pushes a promotion branch.

The production job records the exact `main` authority commit and checks it again immediately before immutable publication. A tag may identify an older source commit on `main`, but it cannot restore trust or Channel state from that older commit. If current authority changes after validation, publication fails before creating the GitHub Release and must be retried against the new public authority.

**Agent**

Monitor without approving the Environment deployment:

```bash
gh run list --workflow release.yml --limit 10
gh run watch <run-id> --exit-status
```

**Human approval**

Review the exact tag, commit, release ID, key ID, sequence, and expiry in GitHub, then approve or reject the `production-release` deployment. Do not provide the secret to the agent.

On success, the workflow summary records:

- the immutable release ID;
- `release-promotion/<release-id>-sequence-<sequence>`;
- the next PR command; and
- the requirement for independent verification before merge.

The stable Channel is not public on `main` until the promotion PR merges.

## Phase 7: create, verify, and merge the promotion PR

### Create or recover the PR

**Agent**

Find the workflow-created branch and ensure it changes only:

```text
releases/channel.json
releases/channel-state.json
releases/trust-state.json
```

Create a PR whose body records the release ID, exact source commit, Channel sequence/expiry, immutable release URL, workflow run URL, and the verification checklist:

```bash
gh pr create \
  --base main \
  --head 'release-promotion/<release-id>-sequence-<sequence>' \
  --title 'release: promote <release-id>' \
  --body-file <public-promotion-body.md>
```

If the branch exists but no PR exists, create the PR; do not rerun signing. If the immutable release exists but the branch does not, follow “Recovery after partial completion” below.

### Independent clean-environment verification

**Agent**

Use a new temporary directory or clean clone. Do not reuse workflow files. Fetch public inputs from the tag, immutable GitHub Release, `origin/main`, and the promotion branch.

Verify:

1. the root SPKI fingerprint equals `releases/root-public-key.sha256`;
2. root signature, trust version, trust expiry, delegated key ID/expiry/revocation, and Channel URL;
3. candidate Channel signature, exact sequence, expiry, and replay checkpoint against the prior `main` state when one exists;
4. manifest signature, release identity, manifest digest, and exact source commit;
5. every manifest-declared artifact's SHA-256 and size;
6. every published top-level release asset's GitHub attestation requires repository `taylorrowser/pi-wait-for-user`, workflow `.github/workflows/release.yml`, and the approved source commit; and
7. the promotion PR contains the exact `channel.json`, `channel-state.json`, and `trust-state.json` published as immutable release assets.

Core metadata verification command:

```bash
node scripts/release-metadata.mjs verify \
  --manifest <download>/release-manifest.json \
  --channel <promotion-branch>/releases/channel.json \
  --trust <main>/releases/release-trust.json \
  --root-key root-2026-1=<main>/releases/root-public-key.pem \
  [--accepted-trust-state <prior-main>/releases/trust-state.json] \
  [--accepted-state <prior-main>/releases/channel-state.json]
```

The bracketed state options are omitted only for the first accepted version/sequence.

For every artifact name in `release-manifest.json`, compare downloaded bytes to the signed digest and size. Separately enumerate every downloaded top-level release asset—including generated manifests, Channel/state files, checksum projections, and archive metadata—and run for each:

```bash
gh attestation verify <published-release-asset> \
  --repo taylorrowser/pi-wait-for-user \
  --signer-workflow taylorrowser/pi-wait-for-user/.github/workflows/release.yml \
  --source-digest <approved-source-commit>
```

Any uncertainty is a hard failure. Do not merge while provenance, sequence, expiry, key authorization, source identity, or stable-file equality is unresolved.

### Secret-material absence check

**Agent**

Search without printing matching content. Exclude the explicitly public test fixtures. Treat any match as a stop condition and ask the human to begin incident handling.

Check:

- the PR diff and non-fixture git history;
- issue and PR bodies/comments;
- workflow logs;
- Actions artifacts; and
- immutable release assets.

Search only for structural indicators such as private-key PEM headers; never search for a production secret's value. Redirect match content to `/dev/null` and report only pass/fail and the public location category.

### Review and merge

**Agent**

1. Run the repository's Standards and Spec review process from a fixed pre-change `origin/main` merge base.
2. Resolve every hard finding and rerun clean verification if the PR bytes change.
3. Confirm required CI is green and the PR is mergeable.
4. Present the verification evidence and exact merge commit that GitHub will create.

**Human approval**

Explicitly authorize merge. A user may authorize the agent in advance with a condition such as “merge this promotion PR when all documented gates are green and no hard findings remain.” Without such authorization, the agent stops with the PR ready.

**Agent, after authorization**

```bash
gh pr merge <number> --merge --delete-branch
```

Then verify the actual merge commit, fetch the stable raw Channel and trust URLs in another clean directory, rerun public metadata verification, and confirm the bytes equal the reviewed PR.

Finally:

1. comment verification evidence on issue #58;
2. close #58 only when every acceptance checkbox is true;
3. update #47's implementation-map status without duplicating design text; and
4. allow #63 to proceed only after both #58 and #62 are complete.

## Recovery after partial completion

Always inspect GitHub state before retrying. Never replace an immutable release and never reuse a Channel sequence with different bytes.

### Unsigned candidate exists; production job not approved

Review the pending deployment. Approve or reject it in GitHub. Do not start a second run.

### Production job failed before creating a GitHub Release

Keep the exact Environment variables frozen. Diagnose using redacted/public evidence. Rerun only after confirming there is no release and no promotion branch for the ID/sequence.

### Immutable release exists; promotion branch is missing

Do not rerun signing. In a clean checkout:

1. download the immutable release's `channel.json`, `channel-state.json`, and `trust-state.json`;
2. independently verify them against the Release Manifest, public root, trust, and prior `main` checkpoints;
3. create `release-promotion/<release-id>-sequence-<sequence>` from current `origin/main`;
4. copy only those three exact public files into `releases/`;
5. commit and push the branch; and
6. continue with the normal promotion PR process.

### Promotion branch exists; PR is missing

Verify the branch and create the PR. Do not rerun the release workflow.

### Promotion PR exists; CI/review is incomplete

Resume review and CI from the existing PR. If signed bytes must change, stop: immutable equal-sequence metadata cannot be edited. Correct the problem through an explicitly reviewed higher sequence/new release as appropriate.

### Immutable release is wrong or suspect

Do not delete, replace, or silently edit it. Stop promotion, preserve public evidence, and follow release-key revocation or root-compromise procedures in `signing-keys.md`. A correction uses a new immutable release identity and/or higher Channel sequence.
