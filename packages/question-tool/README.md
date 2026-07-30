# Pi Question Tool

An independently versioned Pi package that asks one required question or one required question set and holds the originating tool batch durably until the Interaction Request receives a Response, Interruption, or Cancellation.

The package requires the active downstream Pi patch for upstream Pi `v0.81.1`. Unpatched Pi does not provide the durable-deferral protocol and the extension disables its `question` tool when that capability is absent.

## Compatibility

The machine-readable `piWaitForUser` manifest in `package.json` declares:

- core deferred-tool protocol: `1`
- handler: `dev.taylorrowser.pi-question-tool.question` version `1`
- resumable handler versions: `1`
- package request and outcome schema: `1`
- upstream Pi package version: `0.81.1`

Handler and protocol compatibility is exact. Restoring this package to an unavailable saved session makes compatible work available again without rewriting persisted identities.

## Install

The package requires the compatible Patch series to be active on PorcuPi's exact Pi Base. Follow the repository's [PorcuPi instructions](../../README.md#use-through-porcupi), then install this directory through Managed Pi's ordinary package lifecycle:

```sh
porcupi install "$PWD/packages/question-tool"
porcupi list
```

These arguments are forwarded unchanged to Pi. The package is independently selected: PorcuPi does not bundle it, infer it from Patch selection, or treat it as a privileged dependency. Startup identifies the extension as `question-tool.ts`; its model-facing tool name is `question`.

Unpatched Pi lacks protocol v1; the extension detects that absence and does not register `question`.

## Interaction behavior

The `question` tool accepts one or more required questions. Each question has concrete supplied choices and exactly one package-owned inline custom-answer row. Model-provided Other, Custom, or please-specify placeholders are folded into that row.

- Enter saves a supplied choice and advances.
- A single question submits immediately.
- A set requires every answer and reaches an explicit **Review & Submit** screen.
- Up/Down navigates choices; Left/Right navigates questions.
- Selecting or typing in the custom row enters editing mode; Left/Right move within its text.
- Backspace/Delete on a selected custom row enters editing without changing its retained draft; once editing, those keys edit normally.
- Up leaves custom editing for the preceding supplied choice without deleting the draft.
- Escape leaves custom editing without deleting its draft.
- Escape outside editing dismisses presentation without changing lifecycle state and restores Pi's persistent Question summary.
- `/deferred` is the durable re-entry path; `Alt+Q` and `/q` remain package conveniences.
- `/deferred inspect` always opens Pi's generic Retry/Abandon/Close inspector.
- A normal editor message records Interruption and continues the Agent Thread; it is never treated as a Response.
- `Ctrl+O` expands settled history to show questions, choices, descriptions, and selected or custom Responses.

Selections and custom text remain available while navigating within an open form, including after Escape leaves custom-editing mode. They are presentation-local rather than journaled: dismissing the form or leaving the process before submission starts the form again without that unfinished work. The durable Interaction Request itself remains pending and can still be reopened.

Pi core owns the persistent deferred-work affordance, command routing, fallback inspector, and cleanup. The package supplies only the full question presenter and privacy-safe short text (question count, never question content or tool arguments). Missing or failing package presentation falls back to Pi's generic affordance and inspector.

## Programmatic outcomes

Pi's core `resumeDeferred()` and `abandonDeferred()` operations intentionally accept no answers or tool results. SDK or RPC hosts load the package with a controller, record the typed package outcome first, and then call the core operation:

```ts
import {
  createQuestionToolExtension,
  type QuestionToolController,
} from "@taylorrowser/pi-question-tool";

const controller: Partial<QuestionToolController> = {};
const extension = createQuestionToolExtension(controller);

// Supply `extension` through DefaultResourceLoader.extensionFactories.
const request = controller.getActiveRequest?.();
if (!request) throw new Error("No active Question Interaction Request");

const recorded = controller.respond?.(request.requestId, [
  {
    questionId: "environment",
    answer: "Staging",
    kind: "choice",
    selectedIndex: 1,
  },
]);
if (recorded?.status === "recorded") await session.resumeDeferred();
```

`respond()` validates that every required question has exactly one typed Response. `cancel()` records package-owned Cancellation before the host calls `abandonDeferred()`. The first terminal outcome wins; later attempts return the existing outcome without appending a contradiction. Interruption remains core-driven through an ordinary prompt.

An RPC service can host the same controller beside its Pi SDK session and expose a package-specific typed command. Core RPC clients then call `resume_deferred` or `abandon_deferred` only after the package command confirms its durable append.

## Persistence and recovery

The package writes namespaced request and terminal-outcome custom entries around Pi's core `tool_batch_deferred` marker. Normal ordering is:

```text
assistant tool-call batch
Question request
core deferred marker
Question outcome
source-ordered tool results
assistant continuation
```

Opening, reload, resume selection, and tree navigation reconstruct but do not advance the request. If a Response is durable but resumed work remains unavailable, the package preserves that immutable outcome; `/deferred inspect` provides the explicit core recovery path.

## Development

From the repository root, run the dependency-free contract and lifecycle subset with:

```sh
npm test
```

The complete Question Tool suite additionally covers outcome races, in-form editing, process teardown/reopen, Response, Interruption, Cancellation, package discovery, packing, and active Pi conformance. That complete package behavior runs against the composed source through PorcuPi's public-process real-source gate rather than through lifecycle/build machinery in this repository.
