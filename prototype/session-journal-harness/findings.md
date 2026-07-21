# Session-journal spike findings

Observed with the same 22/22 probe result against `@earendil-works/pi-coding-agent` and bundled `pi-agent-core` releases 0.79.10, 0.80.9, and 0.80.10. See the machine-readable reports under [`reports/`](./reports/).

## Verdict

**Yes, with core-owned invariants.** Pi's append-only session JSONL can serve as the canonical local lifecycle record for deferred tool batches and package-owned Interaction Requests. The journal already preserves enough ordered, branch-affiliated information to reconstruct markerless, waiting, ready, partially resumed, complete, and unavailable states after process teardown.

It is not sufficient to add only a new record shape. The core primitive must also own compaction pinning, branch/clone policy, idempotent result advancement, queue ordering, compatible tool rebinding, and malformed-tail handling or an explicitly weaker durability guarantee.

## Observations

### Journal and context

- The assistant tool-call message causes a new session file and all earlier entries to be flushed before pre-execution resolution begins.
- Package custom entries and an unknown first-class `tool_batch_deferred` entry survive reopen and stay on the entry tree.
- Both kinds of control entry advance the active leaf but are excluded from model context. Matching tool results appended after them still follow the same journal branch and appear immediately after the assistant call in reconstructed model context.
- Merely opening a session appends nothing and executes nothing.

### Crash boundaries and recovery

A single branch can distinguish every complete append boundary:

```text
assistant batch                         -> markerless_recovery
+ Interaction Request                  -> markerless_recovery
+ tool_batch_deferred                  -> waiting
+ terminal outcome                     -> ready_to_resume
+ owner result                         -> partial_resume
+ all held-call results                -> complete
```

The stable assistant tool-call IDs are sufficient for deterministic request upsert and tool rebinding. A resume operation can derive only the missing result call IDs and avoid duplicate transcript advancement. `SessionManager` itself does not enforce that idempotency, so it belongs in the new core operation.

### Branches and session operations

- Waiting State is branch-local when reconstructed from `getBranch()`. Scanning all append-order entries instead incorrectly presents an abandoned branch's pending request.
- Reopen selects the latest appended entry as the leaf. A `/tree` move therefore becomes durable only when a new entry is appended on the selected branch.
- Cloning a path currently copies assistant call IDs, custom request identity, marker entry identity, and all other entry IDs verbatim while minting a new session ID.
- Cutting a fork before the deferred batch excludes its Waiting State.
- A new session has a new session ID and no copied entries.

These mechanics do not answer whether a cloned pending request should retain identity, receive identity, or be cancelled in the source. Ticket #4 must define that policy explicitly.

### Compaction

If compaction's `firstKeptEntryId` is the deferred marker, the marker is excluded from model context and so is the preceding assistant tool-call batch. Appending resumed tool results then reconstructs context containing tool results without their assistant tool calls.

If `firstKeptEntryId` pins the assistant entry, the batch remains available. Therefore core must prevent compaction from cutting between an unresolved assistant batch and its final matching results. Blocking compaction while deferred or automatically pinning that assistant entry are both viable; silently summarizing it away is not.

### Tools and queues

- Missing owner tools, missing held siblings, protocol-version mismatches, and handler identity/version mismatches can all be represented as one recoverable `unavailable` state without modifying history.
- Exactly one deferral-capable owner can hold a multi-call batch. Two owners are ambiguous and must be rejected before any tool executes.
- Current steering and follow-up queues are process memory, not Agent Thread history. When either queue is non-empty at the proposed marker boundary, the transition must drain **all** queued input, record Interruption provenance `preexisting_user_input`, and avoid appending a stable deferred marker.

### Torn JSONL tail

Pi skips a malformed final JSONL line on load but does not truncate it. A later append is concatenated directly onto that partial line, so both the torn line and the new valid entry are skipped on the next reopen.

This is narrower than the complete-append crash boundaries above but matters to a strong durability claim. The implementation must either:

1. repair/truncate a malformed final line before appending;
2. use a journal adapter with an atomic record guarantee; or
3. explicitly limit its guarantee to crashes between completed append calls and exclude torn writes/power loss.

`appendFileSync` also does not imply an `fsync` durability boundary.

## Constraints handed to downstream tickets

1. Add a first-class, context-excluded `tool_batch_deferred` entry that advances the branch leaf.
2. Derive markerless recovery only from an unmatched batch with exactly one currently deferral-capable owner.
3. Keep held call IDs, owner ID, protocol version, handler identity/version, and request correlation in the marker.
4. Make resume append only missing results and continue at most once per recorded history state.
5. Keep session opening and reload non-advancing.
6. Reconstruct Waiting State from the active branch, never from all append-order entries.
7. Pin unresolved batches through compaction.
8. Define clone/fork identity and cancellation semantics rather than inheriting raw copied IDs accidentally.
9. Treat any unavailable owner or sibling as batch-wide unavailable; execute none.
10. Drain all pre-marker queued input into an ordered Interruption path.
11. Decide and document the malformed-tail/power-loss durability boundary.
