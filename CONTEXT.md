# Durable Interactivity

This context describes human interactions that temporarily stop an agent thread while preserving an explicit, understandable outcome.

## Language

**Managed Installation**:
An opt-in arrangement in which the normal `pi` invocation selects a verified compatible downstream release while any pre-existing Stock Pi remains untouched and recoverable.
_Avoid_: Replacement install, alias

**Stock Pi**:
An independently installed upstream Pi distribution that does not include this project's durable-deferral patches and Question Tool.
_Avoid_: Fallback Pi, managed Pi

**Managed Dispatcher**:
The stable command boundary of a Managed Installation that selects its active downstream release and routes installation lifecycle operations.
_Avoid_: Shim, per-release wrapper

**Manager Release**:
An immutable signed version of the lifecycle implementation selected alongside a compatible Downstream Release.
_Avoid_: Managed Dispatcher, installer

**Activation**:
The compatible Manager Release and Downstream Release pair selected for subsequent normal `pi` invocations.
_Avoid_: Current symlink, installed release

**Upstream Release**:
A Pi release published by the upstream project without this project's compatibility assertion.
_Avoid_: Stock update

**Downstream Release**:
An immutable distribution that binds one exact Upstream Release to an exact durable-deferral patch series and Question Tool compatibility contract.
_Avoid_: Patched binary, package set

**Pinned Release**:
An installed Downstream Release deliberately exempted from automatic retention cleanup.
_Avoid_: Active release, supported release

**Update Hold**:
A local decision not to advertise or reactivate one specific Downstream Release after rollback; it does not suppress later releases.
_Avoid_: Pinned release, channel freeze

**Managed Update**:
A lifecycle operation that may activate only a verified compatible Downstream Release and never installs an Upstream Release directly.
_Avoid_: Self-update, upstream update

**Release Channel**:
The authenticated downstream publication sequence whose mutable index names the currently supported Downstream Release.
_Avoid_: Latest GitHub release, upstream feed

**Release Manifest**:
The signed immutable source of truth for a Downstream Release's identity, compatibility contract, manager requirements, and artifacts.
_Avoid_: Artifact manifest, receipt, checksum file

**Patch Lag**:
The state in which a newer Upstream Release exists but the Release Channel does not yet contain a compatible Downstream Release for it.
_Avoid_: Update available, update failure

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
