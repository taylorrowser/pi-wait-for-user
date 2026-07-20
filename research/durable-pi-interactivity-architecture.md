# Durable Pi interactivity architecture research

> **Review status:** This report's extension-only recommendation was independently reviewed and is disputed. See [`durable-pi-interactivity-review.md`](./durable-pi-interactivity-review.md), which identifies an unhandled pre-result crash window, continuation idempotency gaps, and misclassified external precedents, and recommends a narrow Pi deferred-tool primitive instead.

Research date: 2026-07-20. Pi under test: `@earendil-works/pi-coding-agent` **0.80.10** (`PKG` = `/Users/taylorrowser/.local/share/mise/installs/node/24.18.0/lib/node_modules/@earendil-works/pi-coding-agent`), bundled `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` inside that root. Experiments ran against the real `pi` CLI in RPC mode with the `openai-codex/gpt-5.6-sol` provider; throwaway extension, driver, and resulting session/event logs are preserved in `research/experiments/`.

Claim labels used throughout: **[V-src]** verified by reading shipped source, **[V-exp]** verified by experiment, **[V-doc]** verified from official docs, **[I]** inference from verified facts, **[R]** recommendation, **[A]** assumption still needing validation.

## Executive recommendation

**Adopt Architecture B — durable yield — implemented as a separately packaged Pi extension/library using only supported public APIs. No Pi core change is required for correct v1 semantics.** [R]

The shape of the recommendation:

1. The LLM-facing tool (and the TypeScript API) durably persists an Interaction Request in the package's pluggable store **before** returning. The tool then returns a real, successful tool result that says "waiting for user; interaction request `<id>`" and sets `terminate: true`. The agent loop settles normally. The tool call's contract is *"the request was registered"*, not *"the answer was delivered"* — this one conceptual move is what makes every history and durability invariant satisfiable.
2. Waiting State = (agent settled) ∧ (unresolved blocking Interaction Request exists for the thread). It is signaled durably and runtime-neutrally via `pi.appendEntry(...)` custom entries — which are persisted in session JSONL, broadcast to TUI/RPC/SDK subscribers as `entry_appended` events, and excluded from LLM context — plus a store-level record that any process can query.
3. A **Response** re-enters the conversation as an extension-injected message (`pi.sendMessage` with `triggerTurn: true`) that names the request id; correlation is by id in content, which the model handles correctly (verified experimentally, and it is exactly the correlation mechanism OpenAI `call_id`, MCP tasks `related-task`, and LangGraph resume values use).
4. An **Interruption** is implemented in the package's `input` event handler: when an ordinary user message arrives while a request is pending, the handler atomically records the `interrupted` terminal outcome in the store before letting the message continue into the normal pipeline.
5. Exactly-once, conflict, and replay semantics live entirely in the package's store (atomic terminal-state transition; delivered-continuation marker), not in Pi.

Why not the others, in one line each (full analysis below):

- **A (long-running tool promise)** is structurally incapable of surviving process/container teardown — the pending `execute()` promise is unrecoverable by design, a crash leaves a dangling tool call whose eventual provider repair is a synthetic *error* result ("No result provided"), queued user messages waiting behind it are lost unpersisted, `abort`/session-replacement can hang or silently drop results, and non-TUI modes hang invisibly. It fails recommendation criteria 1–5 and the container requirement outright.
- **C (first-class Pi suspension primitive)** is implementable but unnecessary: everything it would provide is achievable today with valid history under B, and comparable-system evidence (LangGraph's node-replay idempotency hazards vs. the clean turn-boundary yields of OpenAI `requires_action` and MCP tasks) says suspending *inside* a tool call buys risk, not correctness. Keep it as a possible future ergonomic upgrade, not a v1 dependency.

Two narrowly scoped, **optional** core changes would improve (not enable) the design and are worth filing upstream: (a) a supported way for an extension to contribute fields to RPC `get_state` or emit a typed custom session event, so external runtimes get a first-class waiting flag instead of deriving it from `entry_appended`; (b) a documented "exclusive" tool-call mode (the `executionMode: "sequential"` property that `examples/extensions/question.ts` uses is shipped but undocumented) to harden the sibling-batch edge of `terminate: true`.

## Confidence and remaining unknowns

**High confidence** (source-verified and experiment-confirmed): persistence ordering around tool calls; crash-state on disk; resumability of sessions with dangling tool calls and the synthetic provider repair; `terminate: true` exact semantics including the sibling-batch defeat; abort behavior with a non-settling tool; input-event interception order; `pi.events` process-locality; absence of any existing suspension primitive in core.

**Medium confidence / [I]**: that `entry_appended` is a sufficient runtime-neutral waiting signal for headless runtimes (it is observable over RPC and SDK and durable in JSONL, but it is an event about an entry, not a state field; a poller must combine it with store state). That LLM correlation-by-id stays reliable for weaker models than the one tested — the tested model correlated a Response to `REQ-7F3A` across a process restart, and three external systems rely on the same mechanism, but prompt wording of the yield result matters. [A: validate correlation phrasing across the providers Pi supports.]

**Known unknowns:**

- Whether the undocumented `executionMode: "sequential"` tool property is stable API. It exists in the shipped `question.ts` example but nowhere in docs. [A]
- RPC `steer`/`follow_up` commands bypass the `input` event entirely **[V-src]**. During Waiting State the agent is idle, so compliant clients use `prompt` (which the RPC docs already mandate for extension-visible input), and the interruption path is safe; but a hostile/naive RPC client could inject a steer that the package never sees. The spec must state this constraint. 
- Exact behavior of `ctx.ui.*` dialog calls in `json`/`print` modes ("no-ops" per docs; concrete return values undocumented) — the package must never rely on them outside TUI/RPC. [A, low impact since B never blocks on UI]
- Multi-process concurrent writers to one session file were not tested; the package store, not session JSONL, must be the arbiter of conflicting Responses (which constraint 12 already requires). [A]

## Required semantics and invariants

Position taken on each invariant from the assignment (all are **preserved** by the recommended design; rationale inline):

1. **Every assistant tool call presented to a provider is followed by a protocol-valid matching tool result before the next provider request — PRESERVED, twice over.** Under B the real result ("waiting, request `<id>`") is persisted synchronously in the same turn **[V-src, V-exp]**. Independently, Pi's provider layer (`pi-ai` `transformMessages`, `PKG/node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js` ~125–185) inserts synthetic `isError` "No result provided" results for orphaned calls at payload-build time **[V-src]** — a safety net, but the design never needs it.
2. **Stable request identity independent of process/session-object identity — PRESERVED.** The id is minted by the package and persisted in the store and in the tool result text/details; it never depends on Pi's toolCallId (though the store records it as provenance).
3. **Exactly one terminal outcome — PRESERVED** by an atomic compare-and-set on the store record: `pending → responded | interrupted | cancelled | expired`. Losers of the race receive a typed conflict.
4. **Replays cannot advance the agent twice — PRESERVED.** Continuation delivery is guarded by a `continuationDeliveredAt`/entry-id marker written to the store; delivery is retried only while unset (see flows).
5. **Crash after persisting outcome, before notify/resume — PRESERVED.** Outcome lives in the store; on next `session_start` (any compatible process) the package reconciles: resolved-but-undelivered requests get their continuation injected then marked delivered.
6. **Crash after deciding to resume, before completing continuation — RECOVERABLE without duplicates.** The continuation is a single `pi.sendMessage(..., {triggerTurn:true})`; the delivered-marker is written only after Pi persists the injected message (observable via `entry_appended`/`message_end`); if the crash lands between injection-persist and marker-write, reconciliation sees the already-persisted `custom_message` naming the request id in the session branch and completes the marker instead of re-injecting. [I on the reconciliation read; the entries API (`getEntries`) makes the scan cheap.]
7. **TUI-only details do not enter LLM context by default — PRESERVED.** All waiting/bookkeeping state travels as `custom` entries, which `sessionEntryToContextMessages` maps to *no* context message (`PKG/dist/core/session-manager.js` ~188) **[V-src]**. Only the deliberately minimal tool-result text and the Response/Interruption messages enter context.
8. **Unknown Interaction Kinds remain inspectable and safe — PRESERVED** at the store level: kind is versioned serialized data; a process without a compatible handler can list/display provenance but the answer path requires a registered handler (constraint 10 of the product semantics).
9. **No non-interactive mode waits invisibly forever — PRESERVED.** The yield tool returns immediately in every mode; in `print`/`json` the process then exits/settles with the request discoverable in the store and a waiting entry in JSONL. (Option A hard-fails this: a pending promise in print mode hangs the process with no UI.)
10. **Waiting is observably distinct from productive execution, idle, failure, completion — PRESERVED.** Productive: `isStreaming: true`. Waiting: settled + `interaction:waiting` entry + store record. Generic idle: settled + no record. Failure/completion: their normal signals. Option A cannot satisfy this without extra channels — a hanging tool is indistinguishable from a slow bash call (`get_state` shows only `isStreaming: true`) **[V-exp]**.

## Verified Pi execution and persistence model

### Tool-call event ordering

**[V-src]** The loop (`pi-agent-core/dist/agent-loop.js`) emits `message_end` for the assistant message — including its `toolCall` blocks — *before* any tool executes; `Agent.processEvents` (agent.js ~369) awaits all subscribers, one of which is `AgentSession._handleAgentEvent` (agent-session.js ~350–362), which calls `SessionManager.appendMessage` → synchronous `appendFileSync` (session-manager.js ~663–692). Then per call: `tool_execution_start` → `execute()` → `tool_execution_end` → toolResult `message_start`/`message_end` (persisted the same way) → `turn_end` → next provider request or `agent_end`, then session-level retries/queued continuations, then `agent_settled`.

So the exact answer to the assignment's ordering questions: **the assistant message with the tool call is on disk before `execute()` begins; the tool result is on disk immediately after `execute()` settles and result middleware runs.** Confirmed live in experiment s3: `tool_execution_end` at 17:37:46.209, toolResult `message_end` at .210, `turn_end` .210, `agent_end`/`agent_settled` .211, all persisted (`research/experiments/s3-terminate-after-yield-*.jsonl`). **[V-exp]**

One caveat **[V-src]**: `_persist` defers writing a brand-new session file until the first assistant message exists; irrelevant here because the tool-call-bearing assistant message itself triggers the flush. `--no-session` disables persistence entirely.

### User input while a tool waits

- Submission path: `AgentSession.prompt()` fires the extension `input` event **before** queueing, template expansion, or persistence (agent-session.js ~813–826; runner.js `emitInput` ~885–920) **[V-src]**. A handler returning `{action:"handled"}` consumes the message completely; `transform` rewrites it; handlers are awaited serially, and queueing happens strictly after the handler chain resolves — so an extension can atomically record an Interruption before the message proceeds. **[V-src, I on "atomic": nothing else can enqueue that particular message concurrently.]**
- While a tool is pending, a user message becomes a **steering** message: experiment s1 showed `queue_update {steering:["hello…"]}` with the session file byte-identical before/after — **queued steering messages are memory-only and are lost on process death** (`s1-hang-after-kill-*.jsonl` ends at the dangling toolCall; the "hello" message appears nowhere) **[V-exp]**. Steering drains only after the current tool batch completes (agent-loop.js ~159) — behind a never-resolving tool, queued input waits forever **[V-src]**.
- Gap: `session.steer()`/`session.followUp()` and the RPC `steer`/`follow_up` commands bypass the `input` event (only `prompt`/`sendUserMessage` fire it) **[V-src]**. During Waiting State (agent idle) all ordinary chat arrives via `prompt`, so the Interruption hook holds; the spec must require RPC clients to use `prompt` for user-originated messages (RPC docs already push extension-command traffic to `prompt`).

### Abort, reload, shutdown, and session replacement

- One `AbortController` per run; its signal reaches every `execute()` **[V-src]**. If the tool settles on abort, the rejection is converted to an **error tool result and persisted** (agent-loop.js ~468–475). If the tool ignores the signal, **the run hangs forever**: experiment s5 sent RPC `abort` to a hanging tool whose handler logged `signal-aborted` but never resolved — no `agent_settled` within 30 s, no tool result persisted, session file still ending at the dangling call **[V-exp]**.
- `dispose()` (agent-session.js ~562–577) aborts without awaiting idle and **unsubscribes persistence** — a tool result arriving after disposal is never written. Session replacement (`/new`, `/resume`, `/fork`, RPC `new_session`/`switch_session`/`fork`) has **no streaming guard** and goes through `dispose()` **[V-src]** — replacing a session while a tool waits abandons the promise and loses its result.
- TUI `/reload` is blocked while streaming (`interactive-mode.js` ~4378: "Wait for the current response to finish before reloading"); `AgentSession.reload()` itself has no guard, and RPC/SDK can call it mid-stream **[V-src]** — the modes genuinely differ.
- Abort during assistant streaming persists the partial message with `stopReason:"aborted"`; provider conversion later **drops aborted/error assistant messages entirely** from payloads (transform-messages.js ~153–161) **[V-src]**.

### Crash and restart behavior

- SIGKILL while `execute()` pending: on disk is a well-formed JSONL ending with the assistant `toolCall` message and no result (`s1-hang-after-kill-*.jsonl`) **[V-exp]**.
- Pi reopens such a session without complaint (no load-time validation beyond the header; no repair pass) **[V-src]**; `--continue` + a new prompt produced a successful provider request **[V-exp]**: the orphaned call was repaired payload-side as synthetic `isError` "No result provided" (never written back to JSONL), and the model's reaction was to **call `ask_user` again from scratch** (`s1-hang-resume-resume-after-resume-*.jsonl`) — semantically a *lost* interaction, protocol-validly recovered. This is the best case option A can achieve after a crash even with perfect tooling around it.
- Bare `Agent.continue()` on a transcript ending in an assistant message throws (`"Cannot continue from message role: assistant"`, agent.js ~227–248) **[V-src]** — you cannot resume a dangling call without first appending something.

### Supported extension seams and their limits

- **Append surface** [V-src]: `pi.sendMessage` → `custom_message` entry, enters LLM context as `user` role; `pi.sendUserMessage` → real user message (always triggers a turn); `pi.appendEntry` → `custom` entry, durable, **excluded from context**, emits `entry_appended` to all TUI/RPC/SDK subscribers (agent-session.js ~1867–73) and is readable later via `getEntries`/RPC `get_entries` (which supports durable `since` cursors). **No API appends `assistant` or `toolResult` messages.**
- `ctx.sessionManager` is read-only **by TypeScript type only** (`ReadonlySessionManager` pick); at runtime it is the real `SessionManager` (runner.js ~448–451) with every mutator callable via cast **[V-src]**. Using them would be an unsupported core-internals mutation (and desynchronizes `agent.state.messages` from disk); the recommended design does not need them.
- A true toolResult-continuation is *mechanically* possible SDK-side (`agent.state.messages` push + `sessionManager.appendMessage` + `agent.continue()`) but bypasses `isStreaming`/`agent_settled` bookkeeping and is unsupported **[V-src/I]** — identified per the assignment's rule as a de-facto core change; not recommended.
- `terminate: true` **[V-src, V-exp]**: skips the follow-up LLM call only when **every** finalized result in the batch terminates; experiment s3b (yield_wait + echo_note in one message) confirmed the loop issued another provider request. Queued steering messages also defeat termination (loop condition `hasMoreToolCalls || pendingMessages.length > 0`). Both edges are handleable at the package level (see flows).
- `pi.events` is a per-process `EventEmitter` — strictly process-local, no durable transport **[V-src]**. Durability requires session entries or the package store.
- **No suspension/checkpoint/waiting primitive exists anywhere in core** (exhaustive search: only `waitForIdle`, TUI Ctrl+Z, runtime `pendingToolCalls` set, steering/follow-up queues) **[V-src]**.
- Extensions cannot emit new top-level session event types or extend `get_state` (fixed field set, rpc-mode.js ~343–358); every `AgentSessionEvent` is forwarded verbatim to RPC stdout and SDK subscribers, so `entry_appended` is the supported broadcast channel **[V-src]**.

## External runtime and comparable-system findings

### AgentCore Runtime

**[V-doc]** No "waiting for human" state exists in its model (states: Active / Idle / Stopped). Idle sessions are torn down at `idleRuntimeSessionTimeout` (default 900 s, max 28 800 s) and everything is capped by `maxLifetime` (default/max 8 h); "after session termination, the entire microVM is terminated and memory is sanitized"; a later request with the same `runtimeSessionId` cold-starts a new environment. Holding compute alive while waiting (the `HealthyBusy` ping) is bounded and explicitly discouraged. Waiting across teardown is therefore **application-level**: persist the pending question externally; the human's answer arrives as a *new invocation* on the same session id. (docs.aws.amazon.com/bedrock-agentcore: runtime-sessions, runtime-lifecycle-settings, runtime-long-run, runtime-how-it-works.)

Implication tested against our contract: the neutral waiting contract must expose (a) a durable store queryable by a fresh process, (b) session identity ↔ request mapping, (c) re-entry as a new turn — exactly what B provides. Nothing in B assumes a live process, so an AgentCore adapter is not precluded. **[I]**

### MCP elicitation

**[V-doc]** Base elicitation (spec 2025-06-18) nests a server→client `elicitation/create` request inside the still-open `tools/call` — pure option A, with no durability story. The 2025-11-25 revision added experimental **tasks** precisely to fix this: `tools/call` returns immediately with a task id, status includes **`input_required`**, every related message carries `io.modelcontextprotocol/related-task`, and `model-immediate-response` provides a string "intended to be passed as an immediate tool result to the model." MCP's own evolution is a migration from A to B. (modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks and /changelog.)

### Other directly relevant systems

- **LangGraph `interrupt()`** [V-doc]: the run *returns* (nothing left pending in-process), state checkpointed, resume via `Command(resume=...)` on the same `thread_id`, parallel interrupts correlated by interrupt id. Cost: the interrupted node **re-executes from the top** on resume — all pre-interrupt side effects must be idempotent, its most-documented hazard. Lesson: checkpoint only at boundaries where replay is safe; for a message-loop agent, the turn boundary — which B uses — is that boundary. (docs.langchain.com/oss/python/langgraph/interrupts.)
- **Claude Agent SDK / Claude Code** [V-doc]: `canUseTool` keeps the tool call open in-process ("can stay pending indefinitely"), but for exactly our scenario the docs add the `defer` hook decision — "lets the process exit and resume later from the persisted session," i.e., an explicit A→B escape hatch. (code.claude.com/docs/en/agent-sdk/user-input, /hooks.)
- **OpenAI Assistants `requires_action`** [V-doc]: never offered A; the run yields server-side with per-call `tool_call_id` correlation and resumes via `submit_tool_outputs`. Cautionary details: runs expire after 10 minutes, and the thread hard-locks against new input while a run is pending — evidence that a pending yield needs an expiry/supersession policy and a defined ordinary-input rule (our Interruption semantics are exactly that rule). **Temporal** shows option C done right, but only atop a full deterministic-replay programming model.

Cross-system conclusion **[I]**: every first-party system that had to survive long-latency humans converged on "end the turn with a correlatable waiting result + durable request identity + typed re-entry." Pure A survives only as an in-process fast path.

## Options evaluated

### Long-running tool promise (A)

The tool creates the Interaction Request and keeps `execute()` pending.

Verified behavior: Pi stays `isStreaming: true` for the whole wait, indistinguishable from productive execution in `get_state` **[V-exp]**; ordinary input *can* be intercepted at submission (the `input` event fires even mid-stream for `prompt`-path messages) so in-process Interruption is implementable by resolving the pending promise **[V-src/I]**; but: queued steering input is unpersisted and lost on crash **[V-exp]**; process death leaves a dangling call whose only recovery is a synthetic error result and a model that re-asks from scratch **[V-exp]**; the promise cannot be reconstructed or completed by a later process (no API; `Agent.continue()` rejects assistant-terminal transcripts) **[V-src]**; `abort`/Escape hangs the run unless the tool settles (and settling ends the wait with an aborted outcome) **[V-exp]**; session replacement silently abandons it **[V-src]**; `print`/`json` modes hang invisibly **[I from V-src]**; and holding a container's process open contradicts the teardown requirement and AgentCore's economics **[V-doc]**. Claude Code's `defer` and MCP tasks both exist because their authors hit this same wall.

Verdict: acceptable only as an in-process UX inside other architectures' fast path; unacceptable as the architecture. It fails criteria 1–5.

### Durable yield (B) — recommended

The tool durably creates the request, returns a "waiting" result with `terminate: true`, the loop settles; a later Response or Interruption starts a new continuation correlated by request id.

All load-bearing behaviors verified: valid persisted history in the same turn (s3); loop settles with no follow-up LLM call when the yield is the whole batch (s3); coherent continuation across full process death — resume + Response message → correct, correlated answer (s4: toolCall → toolResult("WAITING… REQ-7F3A") → user Response → assistant "Mango.") **[V-exp]**; the "tool call completed but Interaction Request pending" split is exactly MCP tasks' `model-immediate-response` + `input_required` and OpenAI's `requires_action` — conceptually and operationally sound, with the Waiting State made observable instead of implicit **[V-doc/I]**.

Edges and their handling: sibling batch defeats `terminate` (s3b) → prompt guidelines demand the tool be called alone; a `tool_call` gate blocks other tools in a batch that contains the wait tool (supported API); and if a follow-up LLM call happens anyway, the model sees the waiting result and ends its turn — degraded cost, not corrupted state **[R]**. Queued steering defeats `terminate` → the package treats any pre-queued message delivered after the yield as an Interruption (detectable in the `input` handler at submission time plus a `turn_start`/`context` check) **[R]**. Idempotency/atomicity live in the store (invariants 3–6 above).

### First-class Pi suspension primitive (C)

What it would take **[I from V-src]**: a persisted pending-tool-call marker entry type (session format change + migration for older Pi), suppression of the orphan-repair for suspended calls plus payload-side representation rules, a rebinding mechanism so a recreated runtime re-enters `executeToolCalls` mid-batch (the current loop has no entry point there — `runLoop` is a straight-line async function), new state surface in `get_state`/events for TUI/RPC/SDK/JSON/print, ordering rules for interruption vs. resumption, and changes in both `pi-agent-core` (loop, Agent state) and `pi-coding-agent` (session manager, modes). That is a broad, cross-package change with compatibility obligations — the opposite of "narrowest."

Against criteria: it would satisfy 1–5 *if built correctly*, but LangGraph demonstrates the replay/idempotency tax of suspending inside execution, and nothing in the product semantics requires resuming *inside* the original tool call — the outcome is typed data the LLM consumes in a later turn either way. Criterion 9 (minimal core change) and 6 (supported APIs) weigh decisively against; and since B satisfies 1–6 fully, the assignment's own tiebreaker ("extension-only that fails the first six is not acceptable merely because it avoids core changes" — B fails none) resolves this.

### Any additional option

**B′: durable yield + unsupported toolResult splice-in on resume** (deliver the Response as a real `toolResult` for the original call by mutating `agent.state.messages` + `appendMessage` + `continue()`). Rejected: it is a de-facto core change wearing an extension's clothes (bypasses `isStreaming`/`agent_settled`, types forbid it), and the *only* thing it buys over B is cosmetic — the answer arriving in the tool-result slot instead of a correlated message. If that cosmetics ever matters, propose it upstream as a real API instead. **[R]**

## Decision matrix

Criteria in the assignment's priority order. ✔ = satisfied, ✖ = not satisfied, ◐ = partially / with caveats; notes are load-bearing.

| # | Criterion | A: long-running promise | B: durable yield | C: suspension primitive |
|---|---|---|---|---|
| 1 | Correct provider/session history | ◐ — protocol-*valid* only via synthetic "No result provided" **error** repair after crash; semantically wrong outcome [V-exp] | ✔ — real result persisted in-turn; nothing dangling, ever [V-exp] | ✔ if built; requires new entry type + payload rules to stay valid [I] |
| 2 | Recovery after full process/container teardown | ✖ — promise unrecoverable; queued input lost; model re-asks [V-exp] | ✔ — store + settled session; any compatible process continues [V-exp] | ✔ by design, at the cost of building rebinding machinery [I] |
| 3 | Exactly-once continuation, idempotent outcomes | ✖ — no durable identity to anchor idempotency; crash loses the wait itself | ✔ — store CAS + delivered-marker; replay-safe [R, mechanics verified feasible] | ◐ — must solve resume-replay (LangGraph's documented hazard) [V-doc] |
| 4 | Clear observable Waiting State | ✖ — `isStreaming:true`, identical to slow bash [V-exp] | ✔ — settled + durable `interaction:waiting` entry + store record; `entry_appended` reaches RPC/SDK [V-src] | ✔ — would be first-class (`get_state` field) [I] |
| 5 | Correct ordinary-message Interruption | ◐ — in-process interception works [V-src]; lost across crash; steer-queue delivery quirks | ✔ — `input` handler CAS-interrupts then lets the message flow; agent is idle so all chat passes through `prompt` [V-src] | ✔ if ordering rules are built [I] |
| 6 | Supported, maintainable Pi APIs | ◐ — supported APIs only, but relies on process immortality no API promises | ✔ — registerTool, terminate, appendEntry, sendMessage, input, session_start, get_entries: all documented [V-doc] | ✖ — is, by definition, core surgery in two packages [I] |
| 7 | Independent reusable package boundary | ◐ — package possible but its guarantees evaporate outside TUI | ✔ — store/transport/UI cleanly separable; workflow-free | ✖ for the package (it becomes a Pi-version-coupled feature) |
| 8 | TUI quality | ✔ — inline blocking dialog is the classic UX (question.ts) | ✔ — settled agent + reopenable widget; equal UX, and dismiss/reopen is *more* natural | ✔ |
| 9 | Minimal Pi core changes | ✔ — none | ✔ — none required; two optional niceties | ✖ — session format, loop, state, modes, migration |
| 10 | Implementation simplicity | ✔ superficially — until abort/teardown/interrupt handling, which cannot be finished correctly | ◐ — store + reconciliation + interruption logic; all buildable, all testable | ✖ — largest and riskiest |

B is the only option satisfying all of criteria 1–6.

## Recommended end-to-end state/history flows

Message notation: `U` user, `A⟨tc⟩` assistant with toolCall, `TR` toolResult, `CM` custom message (context-participating), `CE` custom entry (context-excluded).

### Response in the same process

1. LLM calls `interaction_request` tool → package persists request `R1` (state `pending`) in store → tool returns `TR("Waiting for user input; interaction request R1. Do not proceed; the outcome arrives in a later message referencing R1.")` with `terminate: true`; package writes `CE interaction:waiting {id:R1,…}`.
2. Loop settles (`agent_end` → `agent_settled`); TUI shows the interaction widget; RPC/SDK observers saw `entry_appended`.
3. Human answers in the widget → store CAS `pending → responded(outcome)` → `CE interaction:resolved` → `pi.sendMessage({customType:"interaction:response", content:"Interaction request R1 resolved. Response: …"}, {triggerTurn:true})` → new turn; store marks continuation delivered after the message persists.
   History: `U … A⟨tc⟩ TR(waiting) CM(response) A(continues)` — provider-valid, verified shape (s3+s4).

### Dismiss and reopen

Dismissal is pure UI: widget closes, **no store transition, no entries** (per product semantic 5 — dismissing ≠ interrupting). A persistent compact indicator (status bar) remains; a command/keybinding reopens the widget from store state. On `session_start` the package rebuilds indicators from store + `getEntries()` scan. No LLM-visible effect.

### Ordinary-message Interruption

1. User types a normal chat message while `R1` is pending. The package's `input` handler runs **before queueing/persistence** [V-src]: store CAS `pending → interrupted` (winner-take-all vs. a racing Response), append `CE interaction:resolved {outcome:"interrupted"}`, optionally `transform` to prepend a short context line ("(Interaction request R1 was not answered.)") — then `{action:"continue"}`.
2. The message proceeds normally and triggers the turn. The LLM sees the waiting TR, then a user message (optionally annotated) — it knows R1 went unanswered. A Question Tool UI renders the request as "Unanswered."
   Ordering is safe because the agent is idle in Waiting State; every ordinary path (TUI Enter, RPC `prompt`, `sendUserMessage`) flows through `prompt()` → `input` event. Spec note: RPC `steer`/`follow_up` bypass the hook and are queue-only commands; during Waiting State they would also *not* trigger a turn by themselves (`triggerTurn` semantics) — but the spec should still forbid them for user chat. [V-src + R]

### Process death and later Response

1. Any time after step 1 of the first flow — including mid-teardown of a container — the process dies. On disk: settled session ending `…A⟨tc⟩ TR(waiting)`; store: `R1 pending`. Nothing is lost because nothing lived only in memory.
2. A later compatible process starts (same session via `--continue`/`--session`, or an external runtime re-invocation), package `session_start` reconciliation: finds `R1 pending` → re-signals Waiting State (widget/indicator/entry if the leaf lacks one).
3. Human responds (this process's UI, or an external resolution path writing to the store) → same as flow 1 step 3. Verified end-to-end in experiments s3 → kill → s4: the resumed model produced the correlated answer. **[V-exp]**
4. Crash windows: outcome persisted but continuation not injected → reconciliation injects (guard: delivered-marker). Injected but marker unwritten → reconciliation finds the `custom_message` naming R1 in the current branch and only writes the marker. Both idempotent. [R]

### Duplicate/conflicting Responses

Two processes (or a replayed webhook) submit outcomes for `R1`. The store performs one atomic terminal transition; the second submitter receives `{conflict: {winning: {outcome, at, by}}}`. Continuation injection is keyed to the winning transition only; replays of the winning notification are absorbed by the delivered-marker. Session JSONL is never the arbiter — the store is. Concurrency control is a store-adapter obligation (local: e.g. SQLite transaction or lockfile+fsync journal; containerized: the external store's CAS). [R; A: choose and validate the local store's locking under two live `pi` processes.]

## Package/core boundary

### Extension/library responsibilities

Single package, three internal layers (deep seams, per the workflows handoff):

1. **Core library (runtime-agnostic, no Pi imports):** Interaction Request domain model (id, kind ref, payload, provenance, lifecycle, outcome), Interaction Kind registry (versioned serializable definitions; built-ins: approve, select, multi-select, text, edited-text, schema-validated structured), store interface, waiting-state contract types. Independently testable; this is what Pi Workflows imports.
2. **Pi extension:** the `interaction_request` tool (yield semantics above; prompt guidelines demanding solo invocation; `tool_call` gate blocking sibling tools in the same batch while creating/waiting), the TypeScript creation API (same code path as the tool), `input`-handler Interruption, `session_start` reconciliation, `CE` signaling, Response continuation injection.
3. **TUI layer** (guarded by `ctx.mode === "tui"`): widget, indicator, reopen command; RPC gets the same lifecycle via `entry_appended` + `get_entries` and can resolve via its own UI against the store-backed API.

Non-TUI behavior: tool works identically in every mode (returns immediately); `print` exits with the request pending and discoverable — satisfying "never wait invisibly."

### Persistence adapter responsibilities

Pluggable `InteractionStore`: atomic create (idempotency key upsert), atomic terminal CAS returning winner-or-conflict, delivered-marker update, query by id / list pending (scoped), versioned kind payloads for upgrade survival. Default local adapter under `~/.pi/agent/` (user-wide, per the open decision in the workflows handoff — final scope is a product decision); containerized runtimes supply their own (DynamoDB, etc.). The session JSONL is treated as Pi's record of the *conversation*; the store is the record of the *requests*. `pi.events` is used only as a process-local change-notification optimization, never as transport. **[R]**

### Minimal Pi core changes, if any

None required. Two optional upstream proposals, in priority order:

1. **Extension-contributed state/eventing:** a supported way to add fields to `get_state` and/or emit a typed custom session event (today `_emit` is private and `get_state` is fixed). Elevates the waiting contract from "entry-derived" to first-class for external runtimes.
2. **Document/stabilize `executionMode` (or an `exclusive` flag) on tool definitions** so the wait tool can declare it must not run with siblings, closing the `terminate`-defeat edge structurally instead of behaviorally.

Also worth an upstream bug-style report (affects A-style tools generally, discovered during this research): RPC `abort` on a signal-ignoring tool leaves the run permanently unsettleable, and session replacement during a pending tool silently discards its eventual result.

### Runtime-neutral waiting contract

```ts
type WaitingState =
  | { waiting: false }
  | { waiting: true; request: { id: string; kind: KindRef; createdAt: string;
        provenance: Provenance; sessionId: string; leafEntryId: string } };
```

Entry conditions/exit conditions are defined purely by store transitions; observers get it three redundant ways: (a) store query (works with zero Pi process — the AgentCore-shaped path), (b) `entry_appended` events over RPC/SDK for live push, (c) `get_entries` durable-cursor scan for catch-up. AgentCore facts confirm sufficiency: its model needs only "durable record + re-entry as new invocation," both provided; nothing assumes a live waiter. **[I]**

## Prototype implications

The TUI-only demo Question Tool falls out directly: yield tool + in-memory-with-JSONL-restore store stub (or the real local adapter) + widget with options/custom-answer editor (reuse `question.ts` rendering) + dismiss/reopen command + `input`-handler Interruption marking "Unanswered." Every agreed demo behavior maps to a flow above with no additional Pi capabilities. The prototype should deliberately exercise: kill-and-continue mid-wait (flow 4), and a second `pi` process answering first (flow 5) — both are cheap given the store seam, and they are the two behaviors that distinguish this design from `question.ts`.

## Risks and follow-up decisions

1. **Model correlation quality** — the yield-result and Response phrasing is a prompt-engineering surface; test across Pi's supported providers; consider echoing the original question inside the Response message. [A]
2. **Sibling-batch and steering edge cases** — behavioral mitigations are in place, but an extra assistant turn can occur (cost, not corruption); track the upstream `executionMode` ask. [A]
3. **RPC steer/follow_up bypassing Interruption** — document as a client contract; optionally detect at `turn_start` (pending request + inbound non-Response message → late-interrupt before the provider call via the `context`/`before_agent_start` seam). [R]
4. **Local store concurrency** — pick the mechanism (SQLite vs. journal+lock) and validate the two-process conflict scenario from the acceptance list. [Open decision]
5. **Storage scope** (user vs. project), answer-from-any-cwd, retention/cleanup, external-resolution auth — all remain open product decisions from the workflows handoff; none are blocked by this architecture.
6. **Session branching** — a Response injected while the session leaf has moved (user used `/tree`) needs a defined rule (recommend: continuation only appends to the branch containing the waiting TR; otherwise the request is flagged `orphaned-branch` and surfaced). [A — untested]
7. **Pi version drift** — the design touches only documented APIs, but `terminate`, `input`, and `entry_appended` semantics should be pinned with a compatibility handshake (the workflows handoff already requires one).

## Sources

**Pi source (all under `PKG` above, v0.80.10):** `dist/core/agent-session.js` (event persistence ~350–362; prompt/input ~813–826; dispose ~562–577; bindCore ~1848–1936; entry_appended ~1867–73; reload ~2050–71), `dist/core/session-manager.js` (`_persist` ~663–692; `sessionEntryToContextMessages` ~166–189; load ~256–268), `dist/core/extensions/runner.js` (ctx.sessionManager ~448–451; emitInput ~885–920), `dist/core/extensions/types.d.ts` (ReadonlySessionManager pick; ExtensionAPI), `dist/modes/interactive/interactive-mode.js` (onSubmit ~2076–2258; reload guard ~4378–86), `dist/modes/rpc/rpc-mode.js` (event forwarding ~264–269; get_state ~343–358), `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` (ordering ~105–130, ~177–255; terminate ~377–379; abort-result ~468–475; steering drain ~159), `.../agent.js` (continue guard ~227–248; run lifecycle ~315–336), `node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js` (orphan repair ~125–185; aborted-drop ~153–161). Docs: `docs/extensions.md`, `docs/session-format.md`, `docs/sessions.md`, `docs/rpc.md`, `docs/sdk.md`, `docs/packages.md`, `docs/tui.md`; examples `question.ts`, `questionnaire.ts`, `permission-gate.ts`, `structured-output.ts`, `rpc-extension-ui.ts`.

**Experiments (artifacts in `research/experiments/`, pi 0.80.10, RPC mode, model openai-codex/gpt-5.6-sol, 2026-07-20):** s1-hang (pending-tool state, steer queue loss, SIGKILL), s1-hang-resume (dangling-call resume + provider repair), s5-abort (abort with non-settling tool), s3-terminate (`terminate:true` solo + persisted history), s4-continue (cross-process Response continuation; note the duplicated Response user message in that file is an artifact of an aborted earlier driver run, not Pi behavior), s3b-batch (terminate defeated by sibling). Driver and extension: `driver.mjs`, `ext.ts`.

**External primary sources:** AWS Bedrock AgentCore devguide — runtime-sessions.html, runtime-lifecycle-settings.html, runtime-long-run.html, runtime-how-it-works.html. MCP spec — modelcontextprotocol.io/specification/2025-06-18/client/elicitation; /2025-11-25/basic/utilities/tasks; /2025-11-25/changelog. LangGraph — docs.langchain.com/oss/python/langgraph/interrupts; reference.langchain.com/python/langgraph/types/interrupt. Claude Agent SDK — code.claude.com/docs/en/agent-sdk/user-input; /agent-sdk/hooks. OpenAI Assistants function calling — learn.microsoft.com/en-us/azure/ai-services/openai/how-to/assistant-functions (run expiry corroborated at community.openai.com/t/557536). Temporal — docs.temporal.io/encyclopedia/workflow-message-passing.
