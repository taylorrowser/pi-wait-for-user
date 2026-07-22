import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { QuestionDefinition } from "./contracts.ts";
import type { QuestionResponse } from "./lifecycle.ts";

interface QuestionDraft {
	selectedChoice?: number;
	customText: string;
}

type QuestionDrafts = Record<string, QuestionDraft>;

export function cloneDrafts(drafts: QuestionDrafts): QuestionDrafts {
	return Object.fromEntries(
		Object.entries(drafts).map(([id, draft]) => [id, { ...draft }]),
	);
}

export function responseFor(
	question: QuestionDefinition,
	draft: QuestionDraft | undefined,
): QuestionResponse | undefined {
	if (!draft || draft.selectedChoice === undefined) return undefined;
	if (draft.selectedChoice === question.options.length) {
		const answer = draft.customText.trim();
		if (!answer) return undefined;
		return { questionId: question.id, answer, kind: "custom" };
	}
	const option = question.options[draft.selectedChoice];
	if (!option) return undefined;
	return {
		questionId: question.id,
		answer: option.label,
		kind: "choice",
		selectedIndex: draft.selectedChoice + 1,
	};
}

export function allResponses(
	questions: QuestionDefinition[],
	drafts: QuestionDrafts,
): QuestionResponse[] | undefined {
	const responses: QuestionResponse[] = [];
	for (const question of questions) {
		const response = responseFor(question, drafts[question.id]);
		if (!response) return undefined;
		responses.push(response);
	}
	return responses;
}

function isPrintableInput(data: string): boolean {
	if (data.startsWith("\u001b")) return false;
	return [...data].some((character) => character >= " ");
}

export async function showQuestionForm(
	ctx: ExtensionContext,
	questions: QuestionDefinition[],
	onReady?: (close: () => void) => void,
): Promise<QuestionResponse[] | null> {
	if (ctx.mode !== "tui") return null;
	let drafts: QuestionDrafts = Object.fromEntries(
		questions.map((question) => [question.id, { customText: "" }]),
	);

	return ctx.ui.custom<QuestionResponse[] | null>(
		(tui, theme, _keybindings, done) => {
			const firstUnanswered = questions.findIndex(
				(question) => !responseFor(question, drafts[question.id]),
			);
			let currentQuestionIndex = Math.max(0, firstUnanswered);
			let onReview =
				questions.length > 1 && Boolean(allResponses(questions, drafts));
			let editingCustom = false;
			let choiceIndex = 0;
			let cachedLines: string[] | undefined;
			const customInput = new Input();

			const currentQuestion = (): QuestionDefinition =>
				questions[currentQuestionIndex];
			const currentDraft = (): QuestionDraft =>
				drafts[currentQuestion().id] ?? { customText: "" };
			const refresh = (): void => {
				cachedLines = undefined;
				tui.requestRender();
			};
			const persistDraft = (patch: Partial<QuestionDraft>): void => {
				const question = currentQuestion();
				drafts = cloneDrafts(drafts);
				drafts[question.id] = { ...currentDraft(), ...patch };
			};
			const syncQuestion = (): void => {
				const draft = currentDraft();
				choiceIndex = draft.selectedChoice ?? 0;
				customInput.setValue(draft.customText);
				editingCustom = false;
				refresh();
			};
			const moveToQuestion = (index: number): void => {
				currentQuestionIndex = Math.max(
					0,
					Math.min(questions.length - 1, index),
				);
				onReview = false;
				syncQuestion();
			};
			const showReview = (): void => {
				onReview = true;
				editingCustom = false;
				refresh();
			};
			const advance = (): void => {
				const complete = allResponses(questions, drafts);
				if (questions.length === 1 && complete) {
					done(complete);
				} else if (currentQuestionIndex < questions.length - 1) {
					moveToQuestion(currentQuestionIndex + 1);
				} else {
					showReview();
				}
			};
			const enterCustomEditing = (initialInput?: string): void => {
				choiceIndex = currentQuestion().options.length;
				editingCustom = true;
				persistDraft({ selectedChoice: choiceIndex });
				customInput.setValue(currentDraft().customText);
				if (initialInput) {
					customInput.handleInput(initialInput);
					persistDraft({
						customText: customInput.getValue(),
						selectedChoice: choiceIndex,
					});
				}
				refresh();
			};

			customInput.onSubmit = (value) => {
				const answer = value.trim();
				if (!answer) return;
				customInput.setValue(answer);
				persistDraft({
					customText: answer,
					selectedChoice: currentQuestion().options.length,
				});
				advance();
			};

			const handleReviewInput = (data: string): void => {
				if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")))
					moveToQuestion(questions.length - 1);
				else if (matchesKey(data, Key.tab)) moveToQuestion(0);
				else if (matchesKey(data, Key.enter)) {
					const complete = allResponses(questions, drafts);
					if (complete) done(complete);
				} else if (matchesKey(data, Key.escape)) done(null);
			};

			const handleInput = (data: string): void => {
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
					if (matchesKey(data, Key.up)) {
						editingCustom = false;
						choiceIndex = Math.max(0, choiceIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.tab)) {
						if (currentQuestionIndex === questions.length - 1) showReview();
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
					if (after !== before)
						persistDraft({
							customText: after,
							selectedChoice: currentQuestion().options.length,
						});
					refresh();
					return;
				}

				if (matchesKey(data, Key.left)) {
					if (currentQuestionIndex > 0)
						moveToQuestion(currentQuestionIndex - 1);
					return;
				}
				if (matchesKey(data, Key.right)) {
					if (currentQuestionIndex < questions.length - 1)
						moveToQuestion(currentQuestionIndex + 1);
					else if (questions.length > 1) showReview();
					return;
				}
				if (matchesKey(data, Key.tab)) {
					if (currentQuestionIndex < questions.length - 1)
						moveToQuestion(currentQuestionIndex + 1);
					else if (questions.length > 1) showReview();
					return;
				}
				if (matchesKey(data, Key.shift("tab"))) {
					if (currentQuestionIndex > 0)
						moveToQuestion(currentQuestionIndex - 1);
					return;
				}

				const question = currentQuestion();
				const customIndex = question.options.length;
				if (matchesKey(data, Key.up)) {
					choiceIndex = Math.max(0, choiceIndex - 1);
					refresh();
				} else if (matchesKey(data, Key.down)) {
					const previous = choiceIndex;
					choiceIndex = Math.min(customIndex, choiceIndex + 1);
					if (choiceIndex === customIndex && previous !== customIndex)
						enterCustomEditing();
					else refresh();
				} else if (matchesKey(data, Key.enter)) {
					if (choiceIndex === customIndex) {
						if (!currentDraft().customText.trim()) {
							enterCustomEditing();
							return;
						}
						persistDraft({ selectedChoice: customIndex });
					} else {
						persistDraft({ selectedChoice: choiceIndex });
					}
					advance();
				} else if (matchesKey(data, Key.escape)) {
					done(null);
				} else if (choiceIndex === customIndex && isPrintableInput(data)) {
					enterCustomEditing(data);
				}
			};

			const renderProgress = (lines: string[], width: number): void => {
				if (questions.length === 1) return;
				const segments = questions.map((question, index) => {
					const answered = Boolean(responseFor(question, drafts[question.id]));
					const active = !onReview && index === currentQuestionIndex;
					const text = ` ${answered ? "●" : "○"} ${question.label} `;
					return active
						? theme.bg("selectedBg", theme.fg("text", text))
						: theme.fg(answered ? "success" : "muted", text);
				});
				const review = onReview
					? theme.bg("selectedBg", theme.fg("text", " Review & Submit "))
					: theme.fg("muted", " Review & Submit ");
				lines.push(
					...wrapTextWithAnsi(` ${segments.join(" ")} ${review}`, width),
					"",
				);
			};

			const renderQuestion = (lines: string[], width: number): void => {
				const question = currentQuestion();
				const draft = currentDraft();
				lines.push(
					...wrapTextWithAnsi(` ${theme.fg("text", question.question)}`, width),
					"",
				);
				for (let index = 0; index < question.options.length; index++) {
					const option = question.options[index];
					const cursor = index === choiceIndex;
					const selected = draft.selectedChoice === index;
					const prefix = `${cursor ? ">" : " "} ${selected ? "●" : "○"} ${index + 1}. `;
					const prefixWidth = visibleWidth(prefix);
					const wrapped = wrapTextWithAnsi(
						theme.fg(cursor ? "accent" : "text", option.label),
						Math.max(1, width - prefixWidth),
					);
					wrapped.forEach((line, lineIndex) => {
						lines.push(
							`${lineIndex === 0 ? prefix : " ".repeat(prefixWidth)}${line}`,
						);
					});
					if (option.description) {
						lines.push(
							...wrapTextWithAnsi(
								`${" ".repeat(prefixWidth)}${theme.fg("muted", option.description)}`,
								width,
							),
						);
					}
				}
				const customIndex = question.options.length;
				const customPrefix = `${choiceIndex === customIndex ? ">" : " "} ${draft.selectedChoice === customIndex ? "●" : "○"} ${customIndex + 1}. `;
				if (editingCustom) {
					const label = theme.fg("accent", "Other: ");
					const inputWidth = Math.max(
						1,
						width - visibleWidth(customPrefix) - visibleWidth("Other: "),
					);
					lines.push(
						`${customPrefix}${label}${customInput.render(inputWidth)[0] ?? ""}`,
					);
				} else {
					const label = draft.customText
						? `Other: ${draft.customText}`
						: "Type a custom answer…";
					lines.push(
						...wrapTextWithAnsi(
							`${customPrefix}${theme.fg(choiceIndex === customIndex ? "accent" : "text", label)}`,
							width,
						),
					);
				}
			};

			const renderReview = (lines: string[], width: number): void => {
				lines.push(
					` ${theme.fg("accent", theme.bold("Review Responses"))}`,
					"",
				);
				questions.forEach((question, index) => {
					const draft = drafts[question.id];
					const response = responseFor(question, draft);
					lines.push(
						...wrapTextWithAnsi(
							` ${theme.fg("muted", `${index + 1}. ${question.question}`)}\n   ${response ? theme.fg("text", response.answer) : theme.fg("warning", "Response required")}`,
							width,
						),
					);
					if (draft?.customText && response?.kind !== "custom") {
						lines.push(
							...wrapTextWithAnsi(
								`   ${theme.fg("dim", `Retained custom draft: ${draft.customText}`)}`,
								width,
							),
						);
					}
				});
				lines.push(
					"",
					` ${allResponses(questions, drafts) ? theme.fg("success", "Enter submits the complete Response set") : theme.fg("warning", "Every question needs a Response before submission")}`,
				);
			};

			const render = (width: number): string[] => {
				if (cachedLines) return cachedLines;
				const renderWidth = Math.max(1, width);
				const lines = [theme.fg("accent", "─".repeat(renderWidth))];
				renderProgress(lines, renderWidth);
				if (onReview) renderReview(lines, renderWidth);
				else renderQuestion(lines, renderWidth);
				lines.push("");
				const help = onReview
					? "Enter submit • ←/Shift+Tab back • Esc dismiss"
					: editingCustom
						? "Type to edit • Enter save & next • Esc keep draft & leave editing • Tab next"
						: "↑↓ choices • ←→ questions • Enter save & next • Esc dismiss";
				lines.push(
					...wrapTextWithAnsi(` ${theme.fg("dim", help)}`, renderWidth),
				);
				lines.push(theme.fg("accent", "─".repeat(renderWidth)));
				cachedLines = lines;
				return lines;
			};

			syncQuestion();
			onReady?.(() => done(null));
			return {
				get focused() {
					return customInput.focused;
				},
				set focused(value: boolean) {
					customInput.focused = value;
				},
				render,
				invalidate() {
					cachedLines = undefined;
					customInput.invalidate();
				},
				handleInput,
			};
		},
	);
}
