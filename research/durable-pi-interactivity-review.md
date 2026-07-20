# Independent review of durable Pi interactivity research

Research date: 2026-07-20. Pi under review: `@earendil-works/pi-coding-agent` 0.80.10.

## Conclusion

The two handoffs agree on most verified facts but **do not reach the same architectural conclusion**:

- `/tmp/pi-wait-for-user-suspension-research-answers-handoff.md` recommends a first-class Pi deferred-tool primitive.
- `/tmp/pi-wait-for-user-suspension-research-results-handoff.md` and `research/durable-pi-interactivity-architecture.md` recommend an extension-only durable-yield protocol.

After independently checking Pi source, the preserved experiments, a new crash-window experiment, and the cited primary documentation, I recommend the first conclusion:

> Add a narrow, first-class **durable deferred tool call** primitive to Pi, then implement Interaction Requests, persistence, UI, and runtime integration in the standalone package.

This should resemble Claude Code's `PreToolUse: defer`, not a general serialized-JavaScript-stack or workflow checkpoint. The original tool call remains pending in durable history; a later process re-runs its pre-execution decision and either defers again or executes it with the recorded Response/Interruption.

An extension-only durable yield remains useful for the throwaway Question Tool prototype and as a possible compatibility fallback. It does **not** meet the stronger production contract without changing the meaning of the initiating tool and accepting weaker crash/history guarantees.

## Where the reports agree

Both reports correctly establish that:

1. A long-running `tool.execute()` promise is unsuitable for process/container teardown.
2. Pi persists the assistant tool-call message before executing the tool and persists the tool result only after execution settles.
3. A kill during execution can leave a session ending in an unmatched assistant tool call.
4. Current supported extension APIs cannot append a matching `toolResult` or resume that exact pending call.
5. `pi-ai` repairs unmatched calls only in the provider payload with an ephemeral error result, `No result provided`; it does not repair JSONL or carry the real human outcome.
6. User input submitted through `prompt()` reaches the `input` extension event before it is queued or persisted.
7. `terminate: true` prevents the automatic next model request only when every result in the tool batch terminates; a sibling or queued steering message can defeat it.
8. A process-local event bus is not durable transport.
9. AgentCore Runtime provides lifecycle and teardown behavior, not the missing Pi-level human-interaction checkpoint.
10. The Interaction Request store needs stable identity, atomic terminal-state transitions, idempotency, reconciliation, and pluggable external persistence.

These findings are well supported by the installed Pi source and the preserved experiment logs.

## Independent Pi verification

### Tool-call persistence ordering

`pi-agent-core/dist/agent-loop.js` finalizes and emits the assistant `message_end` before collecting and executing its tool calls. `pi-coding-agent/dist/core/agent-session.js` handles that event and synchronously appends the assistant message through `SessionManager`. Only after `execute()` settles does the loop emit the matching tool-result `message_end`.

Therefore every architecture implemented inside `execute()` has a non-atomic interval:

```text
assistant tool call persisted
  -> extension/tool side effects
  -> tool result persisted
```

A process can die at any point in that interval.

### Supported recovery surface

The public extension actions in `dist/core/extensions/types.d.ts` expose:

- `sendMessage(...): void`
- `sendUserMessage(...): void`
- `appendEntry(...): void`

They do not expose appending a matching `toolResult`, resuming a pending tool batch, or awaiting a durable message-injection boundary. `ctx.sessionManager` is read-only in the public type. Calling hidden mutators through casts would be unsupported and would also risk divergence between session JSONL and in-memory agent state.

`Agent.continue()` rejects a transcript whose last message is an assistant message. Provider conversion can synthesize `No result provided`, but that is an error result generated only for an outgoing payload.

### New crash-window experiment

I ran an additional real-Pi RPC experiment using:

- `/tmp/pi-yield-window-extension.ts`
- `/tmp/pi-yield-window-driver.mjs`
- result: `/tmp/pi-yield-window-result.json`

The probe tool durably wrote a pending Interaction Request, then intentionally paused before returning its proposed waiting result. The driver killed Pi after confirming the request write.

Observed state:

- external request store: pending request exists;
- Pi JSONL: ends with the assistant `yield_window_probe` tool call;
- Pi JSONL: no matching tool result exists.

This is the exact interval omitted by the extension-only report. Making the interval short does not make the operation atomic; a real external persistence call generally makes it longer.

### Message-injection durability

The extension-only report proposes `pi.sendMessage(..., { triggerTurn: true })` plus a delivered marker. In 0.80.10, `pi.sendMessage` is intentionally fire-and-forget and returns `void`; its bound implementation starts an async run and catches errors internally. Extension `message_end` handlers run before `AgentSession` persists that message. There is no supported post-persist acknowledgement to await.

A later reconciliation scan can detect that a custom message was appended, but the presence of that message does not prove the subsequent model continuation completed. If the process dies after persisting the custom message but before a final assistant response, current extension APIs have no idempotent `continue from this context message` operation. Re-injecting can duplicate the logical continuation; merely marking delivered can lose it.

A core deferred-call completion path can instead append the matching result idempotently and leave a restartable transcript ending in `toolResult`, from which core can deliberately continue.

### Sibling-batch enforcement

The extension-only report suggests a `tool_call` gate can block every sibling when a waiting tool appears. Current parallel preflight processes calls in assistant source order. A sibling that appears before the waiting tool has already passed preflight by the time the extension discovers the waiting tool; it cannot be retroactively blocked through the supported `tool_call` result. `executionMode: "sequential"` changes execution ordering but does not stop the remaining calls and does not change the all-results-must-terminate rule.

Core support is needed for the reliable rule used by Claude Code: deferral is valid only for a single-call batch.

## Why the extension-only report's conclusion does not follow

### 1. It silently changes the tool contract

The agreed product question concerns a tool call whose progress depends on human input. Durable yield changes that tool into `register_interaction_request`: it successfully returns before any Response exists. The later Response is a new custom/user-like message, not the result of the original tool call.

That can be a valid product, but it is not semantically equivalent. It weakens typed tool-result correlation and conflicts with the original requirement that the waiting tool resolve after the human outcome.

### 2. Its strongest history claim is false at one crash point

The report says durable yield leaves "nothing dangling, ever" and always persists a real waiting result in-turn. The new experiment demonstrates the counterexample: death after request creation but before returning/persisting the waiting result leaves a dangling call plus a pending request.

An extension can reconcile the request from the store, but it cannot append the missing real result using supported APIs. The next provider call receives Pi's synthetic error result instead.

### 3. Its exactly-once continuation argument is incomplete

Store CAS can make the **human outcome** exactly-once. It does not by itself make Pi continuation exactly-once. The fire-and-forget continuation API has crash windows before message persistence, after message persistence but before the provider call, during the provider call, and before the final assistant message persists. The proposed delivered marker does not distinguish all of those states.

### 4. Its external analogies are misclassified

The official sources do not show broad convergence on extension-style yield:

- **Claude Code defer** preserves the pending tool call in the transcript, exits with `stop_reason: "tool_deferred"`, and on `--resume` fires `PreToolUse` again for the **same tool call**. This is direct precedent for a first-class deferred-tool primitive.
- **OpenAI Assistants `requires_action`** keeps the run pending and requires outputs correlated by `tool_call_id` before the run continues. It is also deferred tool completion, not "waiting result now, user message later."
- **LangGraph interrupts** are first-class runtime/checkpointer suspension. Their node replay caveat argues for a narrow pre-tool defer boundary; it does not argue against runtime support.
- **MCP Tasks** are the closest precedent for durable yield, but their actual operation result is retrieved later through `tasks/result`, while `model-immediate-response` is optional and explicitly provisional. Tasks are designed to let the model continue other work, which differs from this project's thread-exclusive Waiting State.

### 5. Its cross-process experiment is not a clean exactly-once proof

The preserved `s4` session contains the Response user message twice. The handoff explains this as an earlier aborted driver run. The final model correlated the request id successfully, which is useful evidence for model comprehension, but the artifact cannot establish exactly-once delivery or a clean kill-then-resume flow.

## Limits in the first-class-suspension handoff

The first handoff has the stronger conclusion, but its proposed mechanism should be narrowed and corrected:

1. **Defer before tool execution**, rather than serializing a pending `execute()` promise or arbitrary JavaScript continuation.
2. Use the persisted assistant tool call and stable tool-call ID as the replay point.
3. If death occurs before a defer marker is appended, recovery must detect the unmatched eligible tool call and re-run pre-execution resolution. Request creation/upsert must be idempotent from stable provenance.
4. Do not claim universal exactly-once external side effects. Guarantee one recorded outcome and idempotent transcript advancement; tools with external effects still need their own idempotency.
5. Keep Interaction Request domain logic out of Pi core. Core should know only that a tool call is durably deferred and later resumable.

## Recommended narrow Pi primitive

### Core semantics

Add a generic pre-execution decision alongside allow/block:

```ts
type BeforeToolCallResult =
  | { block: true; reason?: string }
  | { defer: true; suspension: SerializableMetadata };
```

A better final API shape should be designed separately; this illustrates the seam, not a committed interface.

Required behavior:

1. Deferral is accepted only when the assistant turn contains exactly one tool call. A multi-call batch must execute none of the calls and produce an explicit retry/error policy, rather than partially executing siblings.
2. The tool does not execute when deferred.
3. Pi durably records the deferred call and emits an explicit waiting/deferred event/state.
4. The active run settles without synthesizing a tool result or making another provider request.
5. On later process startup/resume, Pi rebinds the same tool name, arguments, and tool-call ID, then re-runs pre-execution handling.
6. If the package's store still says pending, it defers again.
7. If the store records a Response or Interruption, the tool executes from the beginning, reads that terminal outcome by deterministic request identity, and returns the exact matching typed tool result.
8. Pi can then either continue immediately (explicit Response) or append an ordinary user message after the result and make one provider request (Interruption).
9. Completing/resuming by suspension ID and outcome version is idempotent.
10. If the tool or compatible Interaction Kind is unavailable, Pi reports a durable unavailable state rather than silently synthesizing `No result provided` and proceeding.

### Package responsibilities

The standalone package still owns:

- Interaction Request and Interaction Kind schemas;
- pluggable request persistence;
- atomic Response/Interruption conflict handling;
- UI, dismissal, reopening, and pending indicators;
- request ownership/provenance/security;
- runtime-neutral waiting notifications;
- reconciliation/outbox behavior;
- compatibility handshake with the required Pi deferred-tool capability.

### Pi responsibilities

Pi core owns only:

- valid pending-tool history;
- deferred run state;
- single-call batch enforcement;
- durable resume of the same tool call;
- ordered completion before a new user message;
- SDK/RPC/TUI/JSON/print observability;
- idempotent transcript advancement.

This is a core feature, but it is much narrower than arbitrary workflow checkpointing.

## When durable yield would be acceptable

Extension-only durable yield is acceptable if the product explicitly adopts all of these weaker semantics:

1. The initiating tool means only "register this request," not "return the human outcome."
2. The later outcome may enter model context as a correlated user/custom message rather than a matching tool result.
3. A crash before the waiting result may be recovered with a synthetic error result on the next provider call.
4. Waiting state is package-derived rather than a canonical Pi run state.
5. Batch exclusivity is best-effort until Pi adds a core feature.
6. Continuation delivery is at-least-once/reconciled rather than a core idempotent resume operation.

Those are meaningful trade-offs, not implementation details. They should not be accepted merely to preserve an extension-only architecture.

## Recommendation for the Wayfinder map

Treat the research decision as:

> Production architecture requires a narrow Pi durable deferred-tool primitive; the independent package builds durable Interaction Requests on top. The Question Tool prototype may use extension-only durable yield to validate UI and package semantics, but must be labeled as a behavioral approximation that cannot prove the final crash/history guarantees.

The next decision ticket should design the deferred-tool interface in `pi-agent-core`, `pi-coding-agent`, extensions, SDK, and RPC in at least two materially different ways before choosing an API.

## Primary sources checked

### Pi 0.80.10 source

- `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`
- `node_modules/@earendil-works/pi-agent-core/dist/agent.js`
- `dist/core/agent-session.js`
- `dist/core/session-manager.js`
- `dist/core/extensions/runner.js`
- `dist/core/extensions/types.d.ts`
- `dist/modes/interactive/interactive-mode.js`
- `dist/modes/rpc/rpc-mode.js`
- `node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js`

All paths are under `/Users/taylorrowser/.local/share/mise/installs/node/24.18.0/lib/node_modules/@earendil-works/pi-coding-agent` unless noted.

### Official external documentation

- Claude Code hooks, “Defer a tool call for later”: https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later
- Claude Agent SDK user input: https://code.claude.com/docs/en/agent-sdk/user-input
- Claude Agent SDK session storage: https://code.claude.com/docs/en/agent-sdk/session-storage
- MCP Tasks: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
- MCP Elicitation: https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- LangGraph interrupts: https://docs.langchain.com/oss/javascript/langgraph/interrupts
- OpenAI Assistants function calling (`requires_action` / `submit_tool_outputs`): https://platform.openai.com/docs/assistants/tools/function-calling
- AgentCore Runtime sessions: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html
- AgentCore long-running agents: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html
