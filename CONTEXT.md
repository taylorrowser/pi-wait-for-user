# Durable Interactivity

This context describes human interactions that temporarily stop an agent thread while preserving an explicit, understandable outcome.

## Language

**Agent Thread**:
The durable conversation lineage in which autonomous work and its Waiting State occur. Interaction Request lifecycle is interpreted along one lineage; outcomes on alternate lineages do not affect it.
_Avoid_: Process, runtime instance

**Access Scope**:
The authorization and discovery boundary for Interaction Requests, such as a local project or an external tenant. Access Scope does not determine which Agent Thread automatically presents a request.
_Avoid_: Conversation, display scope

**Interaction Request**:
A durable request for human input with a stable, session-scoped identity, provenance, and typed outcome that exists independently of any process waiting on it. Its lifecycle is interpreted along an Agent Thread, so alternate lineages may contain alternate outcomes without affecting one another.
_Avoid_: Prompt, dialog, question

**Deferred Tool Batch**:
An assistant-issued set of tool calls held intact before any call executes because exactly one call owns durable deferral.
_Avoid_: Pending tools, suspended execution

**Waiter**:
The active operation whose progress depends on the outcome of an Interaction Request.
_Avoid_: Request, listener

**Waiting State**:
The state of an agent thread that cannot perform further autonomous work because its Waiter depends on an unresolved Interaction Request.
_Avoid_: Running, idle

**Interaction Kind**:
A versioned, serializable contract for the input and outcome shape of a category of Interaction Request. Trusted code may register validation and presentation behavior for additional kinds; an unknown kind remains inspectable but cannot be answered.
_Avoid_: Dialog type, component

**Response**:
Human input explicitly submitted as the successful outcome of an Interaction Request.
_Avoid_: Message, reply

**Interruption**:
The terminal outcome produced when the human continues the agent thread instead of responding to its active Interaction Request.
_Avoid_: Response, implicit answer

**Cancellation**:
The terminal outcome produced when an Interaction Request is deliberately ended without a Response or Interruption. Expiry and administrative cleanup are cancellation reasons. Stopping a Waiter does not itself cancel the Interaction Request.
_Avoid_: Waiter abort, failure, rejection
