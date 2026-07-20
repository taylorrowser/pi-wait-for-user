# Question Tool TUI prototype

> **THROWAWAY — not production architecture.** This branch exists only to evaluate the TUI behavior in [issue #2](https://github.com/taylorrowser/pi-wait-for-user/issues/2).

This extension approximates waiting with `terminate: true`, a later custom message, and Pi session custom entries. It cannot preserve a pending tool call through every crash window and does not replace the required durable deferred-tool-call primitive in Pi core.

## Run

```bash
./prototype/question-tool/run.sh
```

Then ask Pi:

> Use the question tool, by itself, to ask two questions together: which deployment environment I prefer (Development, Staging, or Production, with short descriptions), and which rollout speed I prefer (Careful, Balanced, or Fast). Give each question a short label.

## Evaluation script

1. **Question navigation:** use Left/Right or Tab/Shift+Tab to move through questions. Enter saves a supplied choice and advances.
2. **Inline custom Response:** move down onto **Type a custom answer…** and type directly in that row. Esc leaves editing without clearing the draft; Enter saves and advances.
3. **Draft retention:** return to a question, select a supplied choice, then revisit its custom row. The custom draft should still be present until explicitly deleted or the set is submitted.
4. **Review and submit:** answer every question, review the complete set, go back to revise one, then explicitly submit it.
5. **Dismiss/reopen:** press Esc outside custom editing. The Interaction Request must remain pending; the widget and footer indicator remain. Press Alt+Q or run `/q` to reopen it.
6. **Settled history:** after submission, the tool row must no longer say it is waiting. Press Ctrl+O to reveal every question, supplied choice, description, and Response.
7. **Interruption:** dismiss a new request, then send an ordinary message. The pending Interaction Request should become **Left unanswered** before Pi handles that message.
8. **Reload approximation:** dismiss, exit Pi, run the command again with `--continue`, and confirm that the originating Agent Thread reopens its pending Interaction Request and retained drafts.

## Proposed behavior embodied here

- The interaction opens automatically only after the agent settles.
- One Interaction Request can contain one or several required questions; a multi-question set has an explicit Review & Submit step.
- Supplied choices save on Enter. Exactly one built-in custom-answer row supports direct inline typing and retains its draft across navigation and choice changes; model-supplied custom placeholders are folded into it.
- Navigation mode uses arrows between choices/questions. Custom-editing mode gives arrows to the text cursor; Esc preserves the draft and returns to navigation mode.
- Esc in navigation mode dismisses only the UI; it has no lifecycle effect. Alt+Q and `/q` reopen it.
- A compact widget and footer status keep Waiting State visible after dismissal.
- A normal user message atomically records an Interruption before the next turn. It is not interpreted as a Response.
- Settled tool history shows Answered or Left unanswered rather than stale Waiting State; Ctrl+O expands full details.
- The current Agent Thread has at most one active blocking Interaction Request.
