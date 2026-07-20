/**
 * THROWAWAY PROTOTYPE for https://github.com/taylorrowser/pi-wait-for-user/issues/2
 *
 * This validates Question Tool TUI behavior only. It approximates durable waiting
 * with a terminating tool result and session custom entries; production requires
 * Pi's proposed durable deferred-tool-call primitive.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const STATE_ENTRY = "question-tool-prototype-state";
const INDICATOR_KEY = "question-tool-prototype";
const RESPONSE_MESSAGE = "question-tool-prototype-response";

interface QuestionOption {
	label: string;
	description?: string;
}

interface InteractionRequest {
	id: string;
	toolCallId: string;
	question: string;
	options: QuestionOption[];
	createdAt: string;
}

type StateRecord =
	| { version: 1; status: "pending"; request: InteractionRequest }
	| {
			version: 1;
			status: "responded";
			request: InteractionRequest;
			answer: string;
			wasCustom: boolean;
			selectedIndex?: number;
	  }
	| { version: 1; status: "interrupted"; request: InteractionRequest };

interface QuestionToolDetails {
	status: "error" | "pending";
	request?: InteractionRequest;
	message?: string;
}

interface DialogResult {
	answer: string;
	wasCustom: boolean;
	selectedIndex?: number;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for this supplied choice" }),
	description: Type.Optional(Type.String({ description: "Optional detail shown beneath the choice" })),
});

const QuestionSchema = Type.Object({
	question: Type.String({ description: "The question to ask the human" }),
	options: Type.Array(OptionSchema, { minItems: 1, description: "Supplied choices" }),
});

export default function questionToolPrototype(pi: ExtensionAPI) {
	let active: InteractionRequest | undefined;
	let dialogOpen = false;
	let interruptionForNextTurn: InteractionRequest | undefined;

	function appendState(record: StateRecord): void {
		pi.appendEntry(STATE_ENTRY, record);
	}

	function restoreState(ctx: ExtensionContext): void {
		active = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const record = entry.data as StateRecord | undefined;
			if (record?.version !== 1) continue;
			active = record.status === "pending" ? record.request : undefined;
		}
	}

	function updatePendingIndicator(ctx: ExtensionContext): void {
		if (!active) {
			ctx.ui.setStatus(INDICATOR_KEY, undefined);
			ctx.ui.setWidget(INDICATOR_KEY, undefined);
			return;
		}

		ctx.ui.setStatus(INDICATOR_KEY, ctx.ui.theme.fg("warning", "⏸ waiting for your response"));
		const request = active;
		ctx.ui.setWidget(INDICATOR_KEY, (_tui, theme) => {
			const text = [
				theme.fg("warning", theme.bold("⏸ Waiting for you")) + theme.fg("muted", `  ${request.question}`),
				theme.fg(
					"dim",
					"  /question reopens • Esc only dismisses • sending a normal message leaves it unanswered",
				),
			].join("\n");
			return new Text(text, 0, 0);
		});
	}

	function finishWithResponse(ctx: ExtensionContext, request: InteractionRequest, result: DialogResult): void {
		if (active?.id !== request.id) return;

		appendState({
			version: 1,
			status: "responded",
			request,
			answer: result.answer,
			wasCustom: result.wasCustom,
			selectedIndex: result.selectedIndex,
		});
		active = undefined;
		updatePendingIndicator(ctx);

		const answerDescription = result.wasCustom
			? `The human wrote: ${result.answer}`
			: `The human selected choice ${result.selectedIndex}: ${result.answer}`;
		pi.sendMessage(
			{
				customType: RESPONSE_MESSAGE,
				content: `Interaction Request ${request.id} received a Response.\nQuestion: ${request.question}\n${answerDescription}`,
				display: true,
				details: { requestId: request.id, ...result },
			},
			{ triggerTurn: true },
		);
	}

	async function openQuestion(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") return;
		if (!active) {
			ctx.ui.notify("There is no active Interaction Request in this Agent Thread.", "info");
			return;
		}
		if (dialogOpen) return;

		const request = active;
		dialogOpen = true;
		try {
			const result = await ctx.ui.custom<DialogResult | null>((tui, theme, _keybindings, done) => {
				const choices = [...request.options, { label: "Type a custom answer…", isCustom: true }];
				let choiceIndex = 0;
				let editing = false;
				let cachedLines: string[] | undefined;

				const editorTheme: EditorTheme = {
					borderColor: (text) => theme.fg("accent", text),
					selectList: {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh(): void {
					cachedLines = undefined;
					tui.requestRender();
				}

				editor.onSubmit = (value) => {
					const answer = value.trim();
					if (!answer) return;
					done({ answer, wasCustom: true });
				};

				function handleInput(data: string): void {
					if (editing) {
						if (matchesKey(data, Key.escape)) {
							editing = false;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (matchesKey(data, Key.up)) {
						choiceIndex = Math.max(0, choiceIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						choiceIndex = Math.min(choices.length - 1, choiceIndex + 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						const choice = choices[choiceIndex];
						if ("isCustom" in choice) {
							editing = true;
							refresh();
							return;
						}
						done({ answer: choice.label, wasCustom: false, selectedIndex: choiceIndex + 1 });
						return;
					}
					if (matchesKey(data, Key.escape)) done(null);
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;
					const lines: string[] = [];
					const renderWidth = Math.max(1, width);

					function addWrappedWithPrefix(prefix: string, text: string): void {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							lines.push(...wrapTextWithAnsi(prefix + text, renderWidth));
							return;
						}
						const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
						const continuationPrefix = " ".repeat(prefixWidth);
						for (let index = 0; index < wrapped.length; index++) {
							lines.push(`${index === 0 ? prefix : continuationPrefix}${wrapped[index]}`);
						}
					}

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					addWrappedWithPrefix(" ", theme.fg("warning", "RESPONSE NEEDED"));
					addWrappedWithPrefix(" ", theme.fg("text", request.question));
					lines.push("");

					for (let index = 0; index < choices.length; index++) {
						const choice = choices[index];
						const selected = index === choiceIndex;
						const prefix = selected ? theme.fg("accent", "> ") : "  ";
						const label = `${index + 1}. ${choice.label}`;
						addWrappedWithPrefix(prefix, theme.fg(selected ? "accent" : "text", label));
						if ("description" in choice && choice.description) {
							addWrappedWithPrefix("     ", theme.fg("muted", choice.description));
						}
					}

					if (editing) {
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
						for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
					}

					lines.push("");
					addWrappedWithPrefix(
						" ",
						theme.fg(
							"dim",
							editing
								? "Enter submits • Esc returns to choices"
								: "↑↓ navigate • Enter responds • Esc dismisses without answering",
						),
					);
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			if (active?.id !== request.id) return;
			if (result) {
				finishWithResponse(ctx, request, result);
			} else {
				ctx.ui.notify("Dismissed. The Interaction Request is still waiting; use /question to reopen it.", "info");
				updatePendingIndicator(ctx);
			}
		} finally {
			dialogOpen = false;
		}
	}

	pi.registerTool({
		name: "question",
		label: "Question (prototype)",
		description:
			"Ask the human one blocking question with supplied choices and a custom-answer option. Call this tool alone. The Agent Thread must not continue until the later Response or Interruption.",
		promptSnippet: "Ask the human a blocking multiple-choice question",
		promptGuidelines: [
			"Call question alone in an assistant turn; do not issue sibling tool calls.",
			"After question reports Waiting State, stop autonomous work until its outcome arrives.",
		],
		parameters: QuestionSchema,
		executionMode: "sequential",

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text" as const, text: "This throwaway prototype only supports Pi's TUI mode." }],
					details: { status: "error", message: "TUI unavailable" } satisfies QuestionToolDetails,
					terminate: true,
				};
			}
			if (active) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Agent Thread is already in Waiting State for Interaction Request ${active.id}.`,
						},
					],
					details: { status: "pending", request: active } satisfies QuestionToolDetails,
					terminate: true,
				};
			}

			const request: InteractionRequest = {
				id: `question:${ctx.sessionManager.getSessionId()}:${toolCallId}`,
				toolCallId,
				question: params.question,
				options: params.options,
				createdAt: new Date().toISOString(),
			};
			active = request;
			appendState({ version: 1, status: "pending", request });
			updatePendingIndicator(ctx);

			return {
				content: [
					{
						type: "text" as const,
						text: `WAITING_FOR_HUMAN ${request.id}. Stop now. A later message will carry its Response or Interruption.`,
					},
				],
				details: { status: "pending", request } satisfies QuestionToolDetails,
				terminate: true,
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuestionToolDetails | undefined;
			if (details?.status === "pending") {
				return new Text(
					theme.fg("warning", "⏸ Waiting for your response") +
						theme.fg("dim", "  Esc dismisses; /question reopens"),
					0,
					0,
				);
			}
			const text = result.content.find((part) => part.type === "text");
			return new Text(theme.fg("error", text?.text ?? "Question Tool error"), 0, 0);
		},
	});

	pi.registerCommand("question", {
		description: "Reopen this Agent Thread's active Interaction Request",
		handler: async (_args, ctx) => {
			await openQuestion(ctx);
		},
	});

	pi.registerEntryRenderer(STATE_ENTRY, (entry, _options, theme) => {
		const record = entry.data as StateRecord | undefined;
		if (!record || record.status === "pending") return new Container();
		if (record.status === "responded") {
			const kind = record.wasCustom ? "wrote" : `selected ${record.selectedIndex}`;
			return new Text(
				theme.fg("success", "✓ Response submitted") + theme.fg("muted", ` (${kind}): ${record.answer}`),
				0,
				0,
			);
		}
		return new Text(
			theme.fg("warning", "↪ Left unanswered") +
				theme.fg("muted", " — the human continued with a normal message"),
			0,
			0,
		);
	});

	pi.registerMessageRenderer(RESPONSE_MESSAGE, (message, _options, theme) => {
		const details = message.details as DialogResult | undefined;
		if (!details) return new Text(String(message.content), 0, 0);
		const prefix = details.wasCustom ? "wrote" : `selected ${details.selectedIndex}`;
		return new Text(
			theme.fg("success", "✓ Response") + theme.fg("muted", ` (${prefix}): `) + theme.fg("text", details.answer),
			0,
			0,
		);
	});

	pi.on("session_start", (_event, ctx) => {
		restoreState(ctx);
		updatePendingIndicator(ctx);
		if (active && ctx.mode === "tui") queueMicrotask(() => void openQuestion(ctx));
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (active && ctx.mode === "tui") void openQuestion(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (!active || event.source === "extension") return { action: "continue" as const };

		const request = active;
		appendState({ version: 1, status: "interrupted", request });
		active = undefined;
		interruptionForNextTurn = request;
		updatePendingIndicator(ctx);
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", () => {
		if (!interruptionForNextTurn) return;
		const request = interruptionForNextTurn;
		interruptionForNextTurn = undefined;
		return {
			message: {
				customType: "question-tool-prototype-interruption",
				content: `Interaction Request ${request.id} ended with an Interruption: the human continued the Agent Thread without providing a Response. Do not treat the new user message as an answer to this request.`,
				display: false,
				details: { requestId: request.id },
			},
		};
	});
}
