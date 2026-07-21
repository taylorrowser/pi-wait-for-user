# Pi session-journal compatibility harness

> **THROWAWAY PROTOTYPE — not a production implementation.** This branch is a primary-source artifact for [issue #11](https://github.com/taylorrowser/pi-wait-for-user/issues/11).

## Question

Can Pi's append-only session journal be the canonical local lifecycle record for a deferred tool batch and its deferral-owning Interaction Request without losing the batch across process teardown, branch operations, compaction, unavailable tools, or queued-input races?

The harness drives the `SessionManager` and `Agent` exported by a real installed Pi release. It appends package-owned Interaction Request/outcome custom entries and injects one raw `tool_batch_deferred` JSONL line as a stand-in for the proposed future core entry. That raw append is deliberately unsupported prototype code; it tests the journal substrate, not an extension implementation strategy.

## Run

Against the Pi on `PATH`:

```bash
./prototype/session-journal-harness/run.sh
```

Against one or more separately installed releases:

```bash
./prototype/session-journal-harness/run.sh \
  /tmp/pi-0.80.9/node_modules/@earendil-works/pi-coding-agent \
  /tmp/pi-0.80.10/node_modules/@earendil-works/pi-coding-agent
```

Each run prints pass/fail probes and writes a stable report to `reports/pi-<version>.json`. A changed Pi semantic should fail a named probe or change its observation, making compatibility review explicit.

## What is exercised

- custom and unknown core control entries, active-leaf movement, and model-context exclusion;
- process recreation after each complete append boundary from assistant tool call through all tool results;
- markerless recovery, one deferral owner with held siblings, and idempotent missing-result planning;
- missing/incompatible owner and sibling tools;
- branch-local Waiting State, clone identity copying, fork cuts, new sessions, and non-advancing open/resume;
- compaction with and without pinning the deferred assistant batch;
- current in-memory steering/follow-up queues and the proposed pre-marker drain decision;
- malformed/torn final JSONL records;
- presence or absence of a native `BeforeToolCallResult.defer` capability.

## Reading a pass

Some probes intentionally preserve current hazards. For example, `journal.torn-tail-poisons-next-append` passes when the release still exhibits that behavior. This is a compatibility harness, not a claim that every observed behavior is desirable. The verdict and required design constraints are in [`findings.md`](./findings.md).
