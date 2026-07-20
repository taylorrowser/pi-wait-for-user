/**
 * THROWAWAY PROTOTYPE for https://github.com/taylorrowser/pi-wait-for-user/issues/2
 *
 * This validates Question Tool TUI behavior only. It approximates durable waiting
 * with a terminating tool result and session custom entries; production requires
 * Pi's proposed durable deferred-tool-call primitive.
 */

import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const STATE_ENTRY = "question-tool-prototype-state";
const INDICATOR_KEY = "question-tool-prototype";
const RESPONSE_MESSAGE = "question-tool-prototype-response";

interface QuestionOption {
	label: string;
	description?: string;
}

interface QuestionDefinition {
	id: string;
	label: string;
	question: string;
	options: QuestionOption[];
}

interface InteractionRequest {
	id: string;
	toolCallId: string;
	questions: QuestionDefinition[];
	createdAt: string;
}

interface QuestionDraft {
	selectedChoice?: number;
	customText: string;
}

interface QuestionResponse {
	questionId: string;
	answer: string;
	wasCustom: boolean;
	selectedIndex?: number;
}

interface PendingState {
	version: 1;
	status: "pending";
	request: InteractionRequest;
	drafts: Record<string, QuestionDraft>;
}

interface RespondedState {
	version: 1;
	status: "responded";
	request: InteractionRequest;
	responses: QuestionResponse[];
}

interface InterruptedState {
	version: 1;
	status: "interrupted";
	request: InteractionRequest;
}

type StateRecord = PendingState | RespondedState | InterruptedState;

interface QuestionToolDetails {
	status: "error" | "pending";
	request?: InteractionRequest;
	message?: string;
}

const OptionSchema = Type.Object({
	label: Type.String({
		description: "Display label for one concrete supplied choice; never add Other, Custom, or a text-entry placeholder",
	}),
	description: Type.Optional(Type.String({ description: "Optional detail shown beneath the choice" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable identifier unique within this question set" }),
	label: Type.Optional(Type.String({ description: "Short progress label, such as Scope or Priority" })),
	question: Type.String({ description: "The full question shown to the human" }),
	options: Type.Array(OptionSchema, {
		minItems: 1,
		description: "Concrete supplied choices only; the UI always adds its own inline custom-answer row",
	}),
});

const QuestionSetSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		description: "One or more required questions submitted together as one Interaction Request",
	}),
});

function cloneDrafts(drafts: Record<string, QuestionDraft>): Record<string, QuestionDraft> {
	return Object.fromEntries(Object.entries(drafts).map(([id, draft]) => [id, { ...draft }]));
}

function responseFor(
	question: QuestionDefinition,
	draft: QuestionDraft | undefined,
): QuestionResponse | undefined {
	if (!draft || draft.selectedChoice === undefined) return undefined;
	if (draft.selectedChoice === question.options.length) {
		const answer = draft.customText.trim();
		if (!answer) return undefined;
		return { questionId: question.id, answer, wasCustom: true };
	}
	const option = question.options[draft.selectedChoice];
	if (!option) return undefined;
	return {
		questionId: question.id,
		answer: option.label,
		wasCustom: false,
		selectedIndex: draft.selectedChoice + 1,
	};
}

function allResponses(state: PendingState): QuestionResponse[] | undefined {
	const responses: QuestionResponse[] = [];
	for (const question of state.request.questions) {
		const response = responseFor(question, state.drafts[question.id]);
		if (!response) return undefined;
		responses.push(response);
	}
	return responses;
}

function isPrintableInput(data: string): boolean {
	if (data.startsWith("\u001b")) return false;
	return [...data].some((character) => character >= " ");
}

function isCustomAnswerPlaceholder(option: QuestionOption): boolean {
	const label = option.label.trim().toLowerCase().replace(/[.…:]+$/u, "");
	return (
		/^(other|custom|custom answer|something else)$/u.test(label) ||
		/\bplease specify\b/u.test(label) ||
		/^(type|write|enter)\b.*\b(answer|response|something)\b/u.test(label)
	);
}

export default function questionToolPrototype(pi: ExtensionAPI) {
	let active: PendingState | undefined;
	let dialogOpen = false;
	let interruptionForNextTurn: InteractionRequest | undefined;
	const stateByToolCallId = new Map<string, StateRecord>();

	function appendState(record: StateRecord): void {
		stateByToolCallId.set(record.request.toolCallId, record);
		pi.appendEntry(STATE_ENTRY, record);
	}

	function restoreState(ctx: ExtensionContext): void {
		active = undefined;
		stateByToolCallId.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const record = entry.data as StateRecord | undefined;
			if (record?.version !== 1) continue;
			stateByToolCallId.set(record.request.toolCallId, record);
		}
		for (const record of stateByToolCallId.values()) {
			if (record.status === "pending") active = record;
		}
	}

	function requestSummary(request: InteractionRequest): string {
		return request.questions.length === 1
			? request.questions[0].question
			: `${request.questions.length} questions need Responses`;
	}

	function updatePendingIndicator(ctx: ExtensionContext): void {
		if (!active || dialogOpen) {
			ctx.ui.setStatus(INDICATOR_KEY, undefined);
			ctx.ui.setWidget(INDICATOR_KEY, undefined);
			return;
		}

		ctx.ui.setStatus(INDICATOR_KEY, ctx.ui.theme.fg("warning", "⏸ waiting for your response"));
		const request = active.request;
		ctx.ui.setWidget(INDICATOR_KEY, (_tui, theme) => {
			const text = [
				theme.fg("warning", theme.bold("⏸ Waiting for you")) +
					theme.fg("muted", `  ${requestSummary(request)}`),
				theme.fg(
					"dim",
					"  Alt+Q or /q reopens • Esc only dismisses • a normal message leaves it unanswered",
				),
			].join("\n");
			return new Text(text, 0, 0);
		});
	}

	function finishWithResponse(
		ctx: ExtensionContext,
		request: InteractionRequest,
		responses: QuestionResponse[],
	): void {
		if (active?.request.id !== request.id) return;

		const settled: RespondedState = { version: 1, status: "responded", request, responses };
		appendState(settled);
		active = undefined;
		updatePendingIndicator(ctx);

		const responseLines = responses.map((response) => {
			const question = request.questions.find((candidate) => candidate.id === response.questionId);
			const kind = response.wasCustom ? "wrote" : `selected choice ${response.selectedIndex}`;
			return `${question?.question ?? response.questionId}\n${kind}: ${response.answer}`;
		});
		pi.sendMessage(
			{
				customType: RESPONSE_MESSAGE,
				content: `Interaction Request ${request.id} received its complete Response set.\n\n${responseLines.join("\n\n")}`,
				display: false,
				details: { requestId: request.id, responses },
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

		const request = active.request;
		dialogOpen = true;
		updatePendingIndicator(ctx);
		try {
			const responses = await ctx.ui.custom<QuestionResponse[] | null>((tui, theme, _keybindings, done) => {
				const initialState = active?.request.id === request.id ? active : undefined;
				const firstUnanswered = initialState
					? request.questions.findIndex((question) => !responseFor(question, initialState.drafts[question.id]))
					: 0;
				let currentQuestionIndex = Math.max(0, firstUnanswered);
				let onReview = request.questions.length > 1 && Boolean(initialState && allResponses(initialState));
				let editingCustom = false;
				let choiceIndex = 0;
				let cachedLines: string[] | undefined;
				const customInput = new Input();

				function pending(): PendingState | undefined {
					return active?.request.id === request.id ? active : undefined;
				}

				function currentQuestion(): QuestionDefinition {
					return request.questions[currentQuestionIndex];
				}

				function currentDraft(): QuestionDraft {
					const state = pending();
					if (!state) return { customText: "" };
					return state.drafts[currentQuestion().id] ?? { customText: "" };
				}

				function refresh(): void {
					cachedLines = undefined;
					tui.requestRender();
				}

				function persistDraft(patch: Partial<QuestionDraft>): void {
					const state = pending();
					if (!state) return;
					const question = currentQuestion();
					const next: PendingState = {
						...state,
						drafts: cloneDrafts(state.drafts),
					};
					next.drafts[question.id] = { ...currentDraft(), ...patch };
					active = next;
					appendState(next);
					updatePendingIndicator(ctx);
				}

				function syncQuestion(): void {
					const draft = currentDraft();
					choiceIndex = draft.selectedChoice ?? 0;
					customInput.setValue(draft.customText);
					editingCustom = false;
					refresh();
				}

				function moveToQuestion(index: number): void {
					currentQuestionIndex = Math.max(0, Math.min(request.questions.length - 1, index));
					onReview = false;
					syncQuestion();
				}

				function showReview(): void {
					onReview = true;
					editingCustom = false;
					refresh();
				}

				function advance(): void {
					const state = pending();
					if (!state) return;
					const complete = allResponses(state);
					if (request.questions.length === 1 && complete) {
						done(complete);
						return;
					}
					if (currentQuestionIndex < request.questions.length - 1) {
						moveToQuestion(currentQuestionIndex + 1);
					} else {
						showReview();
					}
				}

				function enterCustomEditing(initialInput?: string): void {
					const question = currentQuestion();
					choiceIndex = question.options.length;
					editingCustom = true;
					persistDraft({ selectedChoice: choiceIndex });
					customInput.setValue(currentDraft().customText);
					if (initialInput) {
						customInput.handleInput(initialInput);
						persistDraft({ customText: customInput.getValue(), selectedChoice: choiceIndex });
					}
					refresh();
				}

				customInput.onSubmit = (value) => {
					const answer = value.trim();
					if (!answer) return;
					customInput.setValue(answer);
					persistDraft({ customText: answer, selectedChoice: currentQuestion().options.length });
					advance();
				};

				function handleReviewInput(data: string): void {
					if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
						moveToQuestion(request.questions.length - 1);
						return;
					}
					if (matchesKey(data, Key.tab)) {
						moveToQuestion(0);
						return;
					}
					if (matchesKey(data, Key.enter)) {
						const state = pending();
						const complete = state ? allResponses(state) : undefined;
						if (complete) done(complete);
						return;
					}
					if (matchesKey(data, Key.escape)) done(null);
				}

				function handleInput(data: string): void {
					if (onReview) {
						handleReviewInput(data);
						return;
					}

					if (editingCustom) {
						if (matchesKey(data, Key.escape)) {
							editingCustom = false;
							refresh();
							return;
						}
						if (matchesKey(data, Key.tab)) {
							if (currentQuestionIndex === request.questions.length - 1) showReview();
							else moveToQuestion(currentQuestionIndex + 1);
							return;
						}
						if (matchesKey(data, Key.shift("tab"))) {
							moveToQuestion(currentQuestionIndex - 1);
							return;
						}
						const before = customInput.getValue();
						customInput.handleInput(data);
						const after = customInput.getValue();
						if (after !== before) persistDraft({ customText: after, selectedChoice: currentQuestion().options.length });
						refresh();
						return;
					}

					if (matchesKey(data, Key.left)) {
						if (currentQuestionIndex > 0) moveToQuestion(currentQuestionIndex - 1);
						return;
					}
					if (matchesKey(data, Key.right)) {
						if (currentQuestionIndex < request.questions.length - 1) {
							moveToQuestion(currentQuestionIndex + 1);
						} else if (request.questions.length > 1) {
							showReview();
						}
						return;
					}
					if (matchesKey(data, Key.tab)) {
						if (currentQuestionIndex < request.questions.length - 1) moveToQuestion(currentQuestionIndex + 1);
						else if (request.questions.length > 1) showReview();
						return;
					}
					if (matchesKey(data, Key.shift("tab"))) {
						if (currentQuestionIndex > 0) moveToQuestion(currentQuestionIndex - 1);
						return;
					}

					const question = currentQuestion();
					const customIndex = question.options.length;
					if (matchesKey(data, Key.up)) {
						choiceIndex = Math.max(0, choiceIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						const previous = choiceIndex;
						choiceIndex = Math.min(customIndex, choiceIndex + 1);
						if (choiceIndex === customIndex && previous !== customIndex) enterCustomEditing();
						else refresh();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						if (choiceIndex === customIndex) {
							const draft = currentDraft();
							if (!draft.customText.trim()) {
								enterCustomEditing();
								return;
							}
							persistDraft({ selectedChoice: customIndex });
						} else {
							persistDraft({ selectedChoice: choiceIndex });
						}
						advance();
						return;
					}
					if (matchesKey(data, Key.escape)) {
						done(null);
						return;
					}
					if (choiceIndex === customIndex && isPrintableInput(data)) enterCustomEditing(data);
				}

				function renderProgress(lines: string[], renderWidth: number): void {
					if (request.questions.length === 1) return;
					const state = pending();
					const segments = request.questions.map((question, index) => {
						const answered = state ? Boolean(responseFor(question, state.drafts[question.id])) : false;
						const activeQuestion = !onReview && index === currentQuestionIndex;
						const text = ` ${answered ? "●" : "○"} ${question.label} `;
						return activeQuestion
							? theme.bg("selectedBg", theme.fg("text", text))
							: theme.fg(answered ? "success" : "muted", text);
					});
					const review = onReview
						? theme.bg("selectedBg", theme.fg("text", " Review & Submit "))
						: theme.fg("muted", " Review & Submit ");
					lines.push(...wrapTextWithAnsi(` ${segments.join(" ")} ${review}`, renderWidth));
					lines.push("");
				}

				function renderQuestion(lines: string[], renderWidth: number): void {
					const question = currentQuestion();
					const draft = currentDraft();
					const customIndex = question.options.length;
					lines.push(...wrapTextWithAnsi(` ${theme.fg("text", question.question)}`, renderWidth));
					lines.push("");

					for (let index = 0; index < question.options.length; index++) {
						const option = question.options[index];
						const cursor = index === choiceIndex;
						const selected = draft.selectedChoice === index;
						const prefix = `${cursor ? ">" : " "} ${selected ? "●" : "○"} ${index + 1}. `;
						const prefixWidth = visibleWidth(prefix);
						const label = theme.fg(cursor ? "accent" : "text", option.label);
						const wrapped = wrapTextWithAnsi(label, Math.max(1, renderWidth - prefixWidth));
						for (let line = 0; line < wrapped.length; line++) {
							lines.push(`${line === 0 ? prefix : " ".repeat(prefixWidth)}${wrapped[line]}`);
						}
						if (option.description) {
							lines.push(
								...wrapTextWithAnsi(
									`${" ".repeat(prefixWidth)}${theme.fg("muted", option.description)}`,
									renderWidth,
								),
							);
						}
					}

					const customCursor = choiceIndex === customIndex;
					const customSelected = draft.selectedChoice === customIndex;
					const customPrefix = `${customCursor ? ">" : " "} ${customSelected ? "●" : "○"} ${customIndex + 1}. `;
					if (editingCustom) {
						const label = theme.fg("accent", "Other: ");
						const inputWidth = Math.max(1, renderWidth - visibleWidth(customPrefix) - visibleWidth("Other: "));
						const inputLines = customInput.render(inputWidth);
						lines.push(`${customPrefix}${label}${inputLines[0] ?? ""}`);
					} else {
						const customLabel = draft.customText
							? `Other: ${draft.customText}`
							: "Type a custom answer…";
						lines.push(
							...wrapTextWithAnsi(
								`${customPrefix}${theme.fg(customCursor ? "accent" : "text", customLabel)}`,
								renderWidth,
							),
						);
					}
				}

				function renderReview(lines: string[], renderWidth: number): void {
					const state = pending();
					lines.push(` ${theme.fg("accent", theme.bold("Review Responses"))}`);
					lines.push("");
					for (let index = 0; index < request.questions.length; index++) {
						const question = request.questions[index];
						const draft = state?.drafts[question.id];
						const response = responseFor(question, draft);
						lines.push(
							...wrapTextWithAnsi(
								` ${theme.fg("muted", `${index + 1}. ${question.question}`)}\n   ${
									response
										? theme.fg("text", response.answer)
										: theme.fg("warning", "Response required")
								}`,
								renderWidth,
							),
						);
						if (draft?.customText && !response?.wasCustom) {
							lines.push(
								...wrapTextWithAnsi(
									`   ${theme.fg("dim", `Retained custom draft: ${draft.customText}`)}`,
									renderWidth,
								),
							);
						}
					}
					lines.push("");
					const complete = state ? allResponses(state) : undefined;
					lines.push(
						` ${
							complete
								? theme.fg("success", "Enter submits the complete Response set")
								: theme.fg("warning", "Every question needs a Response before submission")
						}`,
					);
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;
					const lines: string[] = [];
					const renderWidth = Math.max(1, width);
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					renderProgress(lines, renderWidth);
					if (onReview) renderReview(lines, renderWidth);
					else renderQuestion(lines, renderWidth);
					lines.push("");
					const help = onReview
						? "Enter submit • ←/Shift+Tab back • Esc dismiss"
						: editingCustom
							? "Type to edit • Enter save & next • Esc keep draft & leave editing • Tab next"
							: "↑↓ choices • ←→ questions • Enter save & next • Esc dismiss";
					lines.push(...wrapTextWithAnsi(` ${theme.fg("dim", help)}`, renderWidth));
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					cachedLines = lines;
					return lines;
				}

				syncQuestion();
				return {
					get focused() {
						return customInput.focused;
					},
					set focused(value: boolean) {
						customInput.focused = value;
					},
					render,
					invalidate: () => {
						cachedLines = undefined;
						customInput.invalidate();
					},
					handleInput,
				};
			});

			if (active?.request.id !== request.id) return;
			if (responses) finishWithResponse(ctx, request, responses);
		} finally {
			dialogOpen = false;
			updatePendingIndicator(ctx);
		}
	}

	pi.registerTool({
		name: "question",
		label: "Question (prototype)",
		description:
			"Ask the human one blocking set of required multiple-choice questions with inline custom Responses. Call this tool alone. The Agent Thread must not continue until the later Response or Interruption.",
		promptSnippet: "Ask the human one or more blocking multiple-choice questions",
		promptGuidelines: [
			"Call question alone in an assistant turn; do not issue sibling tool calls.",
			"Group related questions into one question call and give each a unique id and short label.",
			"Give question only concrete supplied choices; never add Other, Custom, free-text, or please-specify choices because question always provides one inline custom-answer row.",
			"After question reports Waiting State, stop autonomous work until its outcome arrives.",
		],
		parameters: QuestionSetSchema,
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
							text: `Agent Thread is already in Waiting State for Interaction Request ${active.request.id}.`,
						},
					],
					details: { status: "pending", request: active.request } satisfies QuestionToolDetails,
					terminate: true,
				};
			}

			const ids = new Set<string>();
			const questions: QuestionDefinition[] = [];
			for (let index = 0; index < params.questions.length; index++) {
				const question = params.questions[index];
				if (ids.has(question.id)) {
					return {
						content: [{ type: "text" as const, text: `Question id must be unique: ${question.id}` }],
						details: { status: "error", message: "Duplicate question id" } satisfies QuestionToolDetails,
						terminate: true,
					};
				}
				ids.add(question.id);

				const options = question.options.filter((option) => !isCustomAnswerPlaceholder(option));
				if (options.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Question ${question.id} must provide at least one concrete supplied choice; the custom-answer row is added automatically.`,
							},
						],
						details: { status: "error", message: "No concrete supplied choices" } satisfies QuestionToolDetails,
						terminate: true,
					};
				}
				questions.push({
					...question,
					label: question.label?.trim() || `Q${index + 1}`,
					options,
				});
			}
			const request: InteractionRequest = {
				id: `question:${ctx.sessionManager.getSessionId()}:${toolCallId}`,
				toolCallId,
				questions,
				createdAt: new Date().toISOString(),
			};
			const drafts = Object.fromEntries(questions.map((question) => [question.id, { customText: "" }]));
			active = { version: 1, status: "pending", request, drafts };
			appendState(active);
			updatePendingIndicator(ctx);

			return {
				content: [
					{
						type: "text" as const,
						text: `WAITING_FOR_HUMAN ${request.id}. Stop now. A later message will carry its complete Response set or Interruption.`,
					},
				],
				details: { status: "pending", request } satisfies QuestionToolDetails,
				terminate: true,
			};
		},

		renderCall(args, theme, context) {
			const questions = Array.isArray(args.questions) ? (args.questions as QuestionDefinition[]) : [];
			const state = stateByToolCallId.get(context.toolCallId);
			const title =
				questions.length === 1
					? questions[0]?.question || "Question"
					: `${questions.length} questions`;
			let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", title);
			if (!context.expanded || questions.length === 0) return new Text(text, 0, 0);

			for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
				const question = questions[questionIndex];
				const settledResponse =
					state?.status === "responded"
						? state.responses.find((response) => response.questionId === question.id)
						: undefined;
				const pendingResponse =
					state?.status === "pending" ? responseFor(question, state.drafts[question.id]) : undefined;
				const response = settledResponse ?? pendingResponse;
				text += `\n\n${theme.fg("text", `${questionIndex + 1}. ${question.question}`)}`;
				for (let optionIndex = 0; optionIndex < question.options.length; optionIndex++) {
					const option = question.options[optionIndex];
					const selected = !response?.wasCustom && response?.selectedIndex === optionIndex + 1;
					text += `\n   ${theme.fg(selected ? "success" : "dim", `${selected ? "●" : "○"} ${optionIndex + 1}. ${option.label}`)}`;
					if (option.description) text += `\n      ${theme.fg("muted", option.description)}`;
				}
				const custom = response?.wasCustom ? response.answer : state?.status === "pending" ? state.drafts[question.id]?.customText : "";
				text += `\n   ${theme.fg(response?.wasCustom ? "success" : "dim", `${response?.wasCustom ? "●" : "○"} ${question.options.length + 1}. Other${custom ? `: ${custom}` : ""}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, context) {
			function currentText(): string {
				const state = stateByToolCallId.get(context.toolCallId);
				if (state?.status === "responded") {
					const summary =
						state.responses.length === 1
							? `✓ Answered: ${state.responses[0].answer}`
							: `✓ ${state.responses.length} Responses submitted`;
					return (
						theme.fg("success", summary) +
						`  ${theme.fg("dim", keyHint("app.tools.expand", "for full details"))}`
					);
				}
				if (state?.status === "interrupted") {
					return theme.fg("warning", "↪ Left unanswered") + theme.fg("muted", " — continued normally");
				}
				const details = result.details as QuestionToolDetails | undefined;
				if (state?.status === "pending" || details?.status === "pending") {
					return theme.fg("warning", "⏸ Waiting for your response") + theme.fg("dim", "  Alt+Q or /q reopens");
				}
				const text = result.content.find((part) => part.type === "text");
				return theme.fg("error", text?.text ?? "Question Tool error");
			}

			return {
				render(width: number) {
					return new Text(currentText(), 0, 0).render(width);
				},
				invalidate() {},
			};
		},
	});

	pi.registerCommand("q", {
		description: "Reopen this Agent Thread's active Interaction Request",
		handler: async (_args, ctx) => {
			await openQuestion(ctx);
		},
	});

	pi.registerShortcut("alt+q", {
		description: "Reopen the active Interaction Request",
		handler: async (ctx) => {
			await openQuestion(ctx);
		},
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

		const request = active.request;
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
				content: `Interaction Request ${request.id} ended with an Interruption: the human continued the Agent Thread without providing its complete Response set. Do not treat the new user message as an answer to this request.`,
				display: false,
				details: { requestId: request.id },
			},
		};
	});
}
