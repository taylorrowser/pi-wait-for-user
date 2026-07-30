# Durable Interaction Source

This context describes the source content retained by `pi-wait-for-user` after lifecycle ownership moved to PorcuPi.

## Language

**Source Repository**:
The exact Git repository and commit from which PorcuPi discovers declarative Patches and Pi discovers ordinary package resources. This repository is a Source Repository; it is not a runtime manager or release channel.
_Avoid_: Distribution, manager release

**Patch**:
A declarative Git-compatible file under `patches/active/` that modifies PorcuPi's exact Pi Base when explicitly selected and applied. A Patch provides no hook, script, dependency, recipe, verifier, or lifecycle authority.
_Avoid_: Plugin, installer

**Question Tool**:
The independently versioned ordinary Pi package under `packages/question-tool/` that presents and records typed outcomes for Question Interaction Requests. It is installed through Pi's public package lifecycle and is not bundled with or implied by Patch selection.
_Avoid_: Built-in dependency, Patch payload

**Agent Thread**:
The durable conversation lineage in which autonomous work and its Waiting State occur. Interaction Request lifecycle is interpreted along one lineage; outcomes on alternate lineages do not affect it.
_Avoid_: Process, runtime instance

**Interaction Request**:
A durable request for human input with a stable, session-scoped identity and typed outcome that exists independently of any process waiting on it.
_Avoid_: Prompt, dialog

**Deferred Tool Batch**:
An assistant-issued set of tool calls held intact before any call executes because exactly one call owns durable deferral.
_Avoid_: Pending tools, suspended execution

**Waiting State**:
The state of an Agent Thread that cannot perform further autonomous work because it depends on an unresolved Interaction Request.
_Avoid_: Running, idle

**Response**:
Human input explicitly submitted as the successful outcome of an Interaction Request.
_Avoid_: Message, reply

**Interruption**:
The terminal outcome produced when the human continues the Agent Thread instead of responding to its active Interaction Request.
_Avoid_: Response, implicit answer

**Cancellation**:
The terminal outcome produced when an Interaction Request is deliberately ended without a Response or Interruption. Stopping a waiting process does not itself cancel the Interaction Request.
_Avoid_: Failure, rejection

## Ownership boundary

- `pi-wait-for-user` owns Patch and Question Tool source content plus their content-facing tests and documentation.
- PorcuPi owns Pi Base selection, composition, activation, launch, verification, rollback, leases, command ownership, cleanup, and uninstall on macOS and Linux.
- Pi owns Question Tool package installation, loading, and project trust.
- Historical `pi-wait-for-user` tags and GitHub Releases retain the old manager only so existing installations can execute their own uninstall. The default branch does not provide a second lifecycle authority.
