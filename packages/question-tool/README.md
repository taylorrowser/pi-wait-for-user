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

The supported release installer builds the exact patched Pi and places this exact Question Tool beside it:

```bash
curl -fsSL https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.6/install.sh | sh
pi-wait-for-user --version
```

The version must be `0.81.1`. The separate `pi-wait-for-user` launcher loads the Question Tool automatically from the precompiled release. Startup identifies the extension as `question-tool.ts`; its model-facing tool name is `question`. The installer does not clone source, require Node/npm/Git, replace an upstream `pi` command, or alter existing Pi settings and sessions. See the repository [installation, verification, rollback, and uninstall guide](../../README.md#fast-install).

The GitHub release also publishes `taylorrowser-pi-question-tool-0.1.3.tgz` as an independently checksummed package artifact. Hosts that already run the exact compatible patch can unpack it and use Pi's normal local-package workflow:

```bash
mkdir pi-question-tool-0.1.3
tar -xzf taylorrowser-pi-question-tool-0.1.3.tgz -C pi-question-tool-0.1.3
pi install "$(pwd)/pi-question-tool-0.1.3/package"
```

Unpatched Pi lacks protocol v1; the extension detects that absence and does not register `question`.

For development against a prepared repository workspace, load the source directly without changing settings:

```bash
.work/pi-v0.81.1/packages/coding-agent/dist/cli.js \
  -e "$(pwd)/packages/question-tool"
```

## Interaction behavior

The `question` tool accepts one or more required questions. Each question has concrete supplied choices and exactly one package-owned inline custom-answer row. Model-provided Other, Custom, or please-specify placeholders are folded into that row.

- Enter saves a supplied choice and advances.
- A single question submits immediately.
- A set requires every answer and reaches an explicit **Review & Submit** screen.
- Up/Down navigates choices; Left/Right navigates questions.
- Selecting or typing in the custom row enters editing mode; Left/Right move within its text.
- Up leaves custom editing for the preceding supplied choice without deleting the draft.
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
