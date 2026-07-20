# Question Tool TUI prototype

> **THROWAWAY — not production architecture.** This branch exists only to evaluate the TUI behavior in [issue #2](https://github.com/taylorrowser/pi-wait-for-user/issues/2).

This extension approximates waiting with `terminate: true`, a later custom message, and Pi session custom entries. It cannot preserve a pending tool call through every crash window and does not replace the required durable deferred-tool-call primitive in Pi core.

## Run

```bash
./prototype/question-tool/run.sh
```

Then ask Pi:

> Use the question tool, by itself, to ask which deployment environment I prefer. Offer Development, Staging, and Production, with short descriptions.

## Evaluation script

1. **Supplied choice:** select one of the choices. It should submit immediately, clear the pending indicator, and let Pi continue.
2. **Custom Response:** ask again, choose **Type a custom answer…**, type a value, and press Enter.
3. **Dismiss/reopen:** ask again and press Esc. The Interaction Request must remain pending; the widget and footer indicator remain. Run `/question` to reopen it.
4. **Interruption:** dismiss again, then send an ordinary message. The pending Interaction Request should become **Left unanswered** before Pi handles that message.
5. **Reload approximation:** dismiss, exit Pi, run the command again with `--continue`, and confirm that the originating Agent Thread reopens its pending Interaction Request.

## Proposed behavior embodied here

- The interaction opens automatically only after the agent settles.
- Supplied choices submit on Enter; a final custom-answer row opens an inline editor.
- Esc in the editor returns to choices. Esc on the choices dismisses only the UI; it has no lifecycle effect.
- A compact widget and footer status make Waiting State visible after dismissal and advertise `/question` for reopening.
- A normal user message atomically records an Interruption before the next turn. It is not interpreted as a Response.
- The current Agent Thread has at most one active blocking Interaction Request.
