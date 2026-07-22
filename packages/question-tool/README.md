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

From the repository root, prepare, build, and source-link the active patched Pi:

```bash
./scripts/pi-patch.mjs prepare .work/pi-v0.81.1
(
  cd .work/pi-v0.81.1
  npm ci --ignore-scripts
  npm run hydrate:model-data
  npm run build:offline
  cd packages/coding-agent
  npm link
)

pi --version
pi conformance
```

The version must be `0.81.1`, and conformance must pass `8/8`. The linked `pi` executable depends on the prepared workspace remaining at that path. See the repository [installation and rollback instructions](../../README.md#build-and-install-the-patched-pi-cli) for details.

Persistently install the Question Tool into that patched Pi:

```bash
pi install "$(pwd)/packages/question-tool"
pi list
```

`pi list` must show the resolved package path. Start `pi` normally after installation. For a one-off run that does not modify settings, use:

```bash
pi -e "$(pwd)/packages/question-tool"
```

Remove the persistent package with:

```bash
pi remove "$(pwd)/packages/question-tool"
```

The package can also be packed independently with `npm pack ./packages/question-tool`. Publishing and archive-ready release artifacts are handled by the subsequent release ticket.

## Interaction behavior

The `question` tool accepts one or more required questions. Each question has concrete supplied choices and exactly one package-owned inline custom-answer row. Model-provided Other, Custom, or please-specify placeholders are folded into that row.

- Enter saves a supplied choice and advances.
- A single question submits immediately.
- A set requires every answer and reaches an explicit **Review & Submit** screen.
- Up/Down navigates choices; Left/Right navigates questions.
- Selecting or typing in the custom row enters editing mode, where arrow keys edit text.
- Escape leaves custom editing without deleting its draft.
- Escape outside editing dismisses presentation without changing lifecycle state.
- `Alt+Q` or `/q` reopens the active request.
- A normal editor message records Interruption and continues the Agent Thread; it is never treated as a Response.
- `Ctrl+O` expands settled history to show questions, choices, descriptions, and selected or custom Responses.

Selections and custom text remain available while navigating within an open form, including after Escape leaves custom-editing mode. They are presentation-local rather than journaled: dismissing the form or leaving the process before submission starts the form again without that unfinished work. The durable Interaction Request itself remains pending and can still be reopened.

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

Opening, reload, resume selection, and tree navigation reconstruct but do not advance the request. If a Response is durable but resumed work remains unavailable, the package preserves that immutable outcome and directs the user to `/deferred` for recovery.

## Development

After preparing, installing, and building the pinned downstream workspace:

```bash
npm run typecheck:question-tool
npm run test:question-tool
```

The Question Tool suite covers contracts, outcome races, in-form editing behavior, process teardown/reopen, Response, Interruption, Cancellation, package discovery, packing, and the active Pi `conformance` command.
