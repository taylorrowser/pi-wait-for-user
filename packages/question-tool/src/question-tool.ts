import {
	type DeferredBatch,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	keyHint,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CORE_PROTOCOL_VERSIONS,
	HANDLER_ID,
	HANDLER_VERSION,
	normalizeQuestionSet,
	PACKAGE_SCHEMA_VERSION,
	type QuestionDefinition,
	type QuestionSetInput,
	REQUEST_ENTRY_TYPE,
	RESUMABLE_HANDLER_VERSIONS,
} from "./contracts.ts";
import {
	createQuestionLifecycleStore,
	type QuestionLifecycleStore,
	type QuestionOutcomeRecord,
	type QuestionRequestRecord,
	type QuestionResponse,
	type RecordQuestionOutcomeResult,
} from "./lifecycle.ts";
import { showQuestionForm } from "./question-form.ts";

const INDICATOR_KEY = "pi-question-tool";

const OptionSchema = Type.Object({
	label: Type.String({
		minLength: 1,
		description:
			"Display label for one concrete supplied choice; never add Other, Custom, or a text-entry placeholder",
	}),
	description: Type.Optional(
		Type.String({ description: "Optional detail shown beneath the choice" }),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({
		minLength: 1,
		description: "Stable identifier unique within this question set",
	}),
	label: Type.Optional(
		Type.String({
			description: "Short progress label, such as Scope or Priority",
		}),
	),
	question: Type.String({
		minLength: 1,
		description: "The full question shown to the human",
	}),
	options: Type.Array(OptionSchema, {
		minItems: 1,
		description:
			"Concrete supplied choices only; the UI always adds its own inline custom-answer row",
	}),
});

const QuestionSetSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		description:
			"One or more required questions submitted together as one Interaction Request",
	}),
});

export interface QuestionToolController {
	getActiveRequest(): QuestionRequestRecord | undefined;
	getOutcome(requestId: string): QuestionOutcomeRecord | undefined;
	respond(
		requestId: string,
		responses: QuestionResponse[],
	): RecordQuestionOutcomeResult;
	cancel(requestId: string, reason: string): RecordQuestionOutcomeResult;
}

function findOwningAssistant(
	branch: SessionEntry[],
	toolCallId: string,
): Extract<SessionEntry, { type: "message" }> {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(content) => content.type === "toolCall" && content.id === toolCallId,
			)
		) {
			return entry;
		}
	}
	throw new Error(`Owning assistant entry for ${toolCallId} was not found`);
}

function createStore(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): QuestionLifecycleStore {
	return createQuestionLifecycleStore({
		getBranch: () => ctx.sessionManager.getBranch(),
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
	});
}

function requestSummary(request: QuestionRequestRecord): string {
	return request.payload.questions.length === 1
		? request.payload.questions[0].question
		: `${request.payload.questions.length} questions need Responses`;
}

function outcomeText(outcome: QuestionOutcomeRecord): string {
	if (outcome.outcome.type === "response") {
		return outcome.outcome.responses
			.map((response) =>
				response.kind === "choice"
					? `${response.questionId}: selected ${response.selectedIndex}. ${response.answer}`
					: `${response.questionId}: wrote ${response.answer}`,
			)
			.join("\n");
	}
	if (outcome.outcome.type === "interruption") return "Left unanswered";
	return `Cancelled: ${outcome.outcome.reason}`;
}

export function createQuestionToolExtension(
	controller?: Partial<QuestionToolController>,
): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let currentContext: ExtensionContext | undefined;
		let activeRequestId: string | undefined;
		let dialogOpen = false;
		let closeDialog: (() => void) | undefined;

		const activeStore = (): QuestionLifecycleStore => {
			if (!currentContext) throw new Error("No active Question Tool session");
			return createStore(pi, currentContext);
		};
		const clearIndicator = (ctx: ExtensionContext): void => {
			ctx.ui.setStatus(INDICATOR_KEY, undefined);
			ctx.ui.setWidget(INDICATOR_KEY, undefined);
		};
		const updatePendingIndicator = (ctx: ExtensionContext): void => {
			const request = activeRequestId
				? createStore(pi, ctx).getRequest(activeRequestId)
				: undefined;
			if (!request || dialogOpen) {
				clearIndicator(ctx);
				return;
			}
			ctx.ui.setWidget(INDICATOR_KEY, (_tui, theme) => {
				return new Text(
					[
						theme.fg("warning", theme.bold("⏸ Question waiting")) +
							theme.fg("muted", `  ${requestSummary(request)}`),
						theme.fg(
							"dim",
							"  Alt+Q or /q to open • Esc only dismisses • a normal message leaves it unanswered",
						),
					].join("\n"),
					0,
					0,
				);
			});
		};
		const showRecoveryIndicator = (
			ctx: ExtensionContext,
			outcome: QuestionOutcomeRecord,
		): void => {
			activeRequestId = undefined;
			ctx.ui.setWidget(
				INDICATOR_KEY,
				(_tui, theme) =>
					new Text(
						theme.fg(
							"warning",
							`${outcome.outcome.type === "response" ? "Response" : "Outcome"} recorded; deferred work remains.`,
						) +
							theme.fg("dim", "  Run /deferred to inspect, retry, or recover."),
						0,
						0,
					),
			);
		};
		const useContext = (ctx: ExtensionContext): QuestionLifecycleStore => {
			currentContext = ctx;
			return createStore(pi, ctx);
		};
		const isCurrentSession = (ctx: ExtensionContext): boolean =>
			currentContext?.sessionManager.getSessionId() ===
			ctx.sessionManager.getSessionId();

		const closeSettledPresentation = (): void => {
			activeRequestId = undefined;
			closeDialog?.();
			closeDialog = undefined;
			if (currentContext) clearIndicator(currentContext);
		};

		if (controller) {
			controller.getActiveRequest = () => {
				const store = activeStore();
				const snapshot = currentContext?.getDeferredBatch();
				if (snapshot?.kind !== "batch" || !snapshot.correlationId)
					return undefined;
				return store.getOutcome(snapshot.correlationId)
					? undefined
					: store.getRequest(snapshot.correlationId);
			};
			controller.getOutcome = (requestId) =>
				activeStore().getOutcome(requestId);
			controller.respond = (requestId, responses) => {
				const result = activeStore().respond(requestId, responses);
				closeSettledPresentation();
				return result;
			};
			controller.cancel = (requestId, reason) => {
				const result = activeStore().cancel(requestId, reason);
				closeSettledPresentation();
				return result;
			};
		}

		const openQuestion = async (ctx: ExtensionContext): Promise<void> => {
			if (ctx.mode !== "tui" || dialogOpen) return;
			const store = useContext(ctx);
			const snapshot = ctx.getDeferredBatch();
			const request =
				snapshot?.kind === "batch" && snapshot.correlationId
					? store.getRequest(snapshot.correlationId)
					: undefined;
			const existingOutcome = request && store.getOutcome(request.requestId);
			if (!request || existingOutcome) {
				if (existingOutcome) showRecoveryIndicator(ctx, existingOutcome);
				else {
					activeRequestId = undefined;
					clearIndicator(ctx);
					ctx.ui.notify(
						"There is no active Question Interaction Request in this Agent Thread.",
						"info",
					);
				}
				return;
			}

			activeRequestId = request.requestId;
			dialogOpen = true;
			updatePendingIndicator(ctx);
			try {
				const responses = await showQuestionForm(
					ctx,
					request.payload.questions,
					(close) => {
						closeDialog = close;
					},
				);
				if (!responses) return;
				const result = store.respond(request.requestId, responses);
				activeRequestId = undefined;
				clearIndicator(ctx);
				if (result.status === "recorded") {
					void pi
						.resumeDeferred()
						.then((operation) => {
							if (operation.deferredBatch && isCurrentSession(ctx))
								showRecoveryIndicator(ctx, result.outcome);
						})
						.catch((error: unknown) => {
							if (!isCurrentSession(ctx)) return;
							showRecoveryIndicator(ctx, result.outcome);
							ctx.ui.notify(
								error instanceof Error ? error.message : String(error),
								"error",
							);
						});
				}
			} finally {
				closeDialog = undefined;
				dialogOpen = false;
				updatePendingIndicator(ctx);
			}
		};

		pi.registerTool({
			name: "question",
			label: "Question",
			description:
				"Ask the human one blocking set of required multiple-choice questions with inline custom Responses. The Agent Thread waits durably until a Response or Interruption.",
			promptSnippet:
				"Ask the human one or more blocking multiple-choice questions",
			promptGuidelines: [
				"Group related questions into one question call and give each a unique id and short label.",
				"Give question only concrete supplied choices; never add Other, Custom, free-text, or please-specify choices because question always provides one inline custom-answer row.",
				"After question enters Waiting State, stop autonomous work until its outcome arrives.",
			],
			parameters: QuestionSetSchema,
			prepareArguments(args) {
				if (
					!args ||
					typeof args !== "object" ||
					!Array.isArray((args as QuestionSetInput).questions)
				) {
					return args as QuestionSetInput;
				}
				return { questions: normalizeQuestionSet(args as QuestionSetInput) };
			},
			deferral: {
				handlerId: HANDLER_ID,
				handlerVersion: HANDLER_VERSION,
				resumableHandlerVersions: RESUMABLE_HANDLER_VERSIONS,
				inspectAvailability: ({ correlationId }, ctx) => {
					const store = useContext(ctx);
					const request = store.getRequest(correlationId);
					if (!request) {
						return {
							status: "unavailable",
							message:
								"The Question Tool package schema is incompatible with the persisted Interaction Request.",
							details: { supportedPackageVersions: [PACKAGE_SCHEMA_VERSION] },
						};
					}
					if (store.hasIncompatibleOutcome(correlationId)) {
						return {
							status: "unavailable",
							message:
								"The Question Tool outcome schema is incompatible with this package version.",
							details: { supportedPackageVersions: [PACKAGE_SCHEMA_VERSION] },
						};
					}
					if (store.getOutcomes(correlationId).length > 1) {
						return {
							status: "unavailable",
							message:
								"The Interaction Request has conflicting terminal outcomes.",
						};
					}
					return { status: "available" };
				},
				resolve: async (operation, _signal, ctx) => {
					const store = useContext(ctx);
					const branch = ctx.sessionManager.getBranch();
					const assistant = findOwningAssistant(branch, operation.toolCallId);
					let request = store.getRequestByOwner(
						assistant.id,
						operation.toolCallId,
					);
					if (!request) {
						const questions = normalizeQuestionSet(
							operation.params as QuestionSetInput,
						);
						request = {
							version: PACKAGE_SCHEMA_VERSION,
							requestId: `question:${assistant.id}:${operation.toolCallId}`,
							assistantEntryId: assistant.id,
							ownerCallId: operation.toolCallId,
							payload: { questions },
						};
						pi.appendEntry(REQUEST_ENTRY_TYPE, request);
					}

					const existing = store.getOutcome(request.requestId);
					if (existing) {
						return {
							status: "ready" as const,
							disposition:
								existing.outcome.type === "response"
									? ("execute_batch" as const)
									: ("complete_owner" as const),
						};
					}
					if (operation.operation === "interrupt") {
						const result = store.interrupt(
							request.requestId,
							operation.provenance,
						);
						return {
							status: "ready" as const,
							disposition:
								result.outcome.outcome.type === "response"
									? ("execute_batch" as const)
									: ("complete_owner" as const),
						};
					}
					if (operation.operation === "cancel") {
						const result = store.cancel(request.requestId, operation.reason);
						return {
							status: "ready" as const,
							disposition:
								result.outcome.outcome.type === "response"
									? ("execute_batch" as const)
									: ("complete_owner" as const),
						};
					}
					return {
						status: "deferred" as const,
						correlationId: request.requestId,
					};
				},
				presenter: async (snapshot: DeferredBatch, ctx) => {
					activeRequestId = snapshot.correlationId;
					await openQuestion(ctx);
				},
			},
			async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
				const store = useContext(ctx);
				const assistant = findOwningAssistant(
					ctx.sessionManager.getBranch(),
					toolCallId,
				);
				const request = store.getRequestByOwner(assistant.id, toolCallId);
				const outcome = request && store.getOutcome(request.requestId);
				if (!request || !outcome)
					throw new Error("Question Tool outcome was not found");
				activeRequestId = undefined;
				clearIndicator(ctx);
				return {
					content: [{ type: "text" as const, text: outcomeText(outcome) }],
					details: { request, outcome },
				};
			},
			renderCall(args, theme) {
				const questions = Array.isArray(args.questions)
					? (args.questions as QuestionDefinition[])
					: [];
				const title =
					questions.length === 1
						? questions[0]?.question || "Question"
						: `${questions.length} questions`;
				return new Text(
					theme.fg("toolTitle", theme.bold("question ")) +
						theme.fg("muted", title),
					0,
					0,
				);
			},
			renderResult(result, options, theme, context) {
				const details = result.details as
					| { request: QuestionRequestRecord; outcome: QuestionOutcomeRecord }
					| undefined;
				if (!details && context.deferredState === "owner") {
					return new Text(
						theme.fg("warning", "⏸ Waiting for your response") +
							theme.fg("dim", "  Alt+Q or /q to open"),
						0,
						0,
					);
				}
				if (!details) {
					const text = result.content.find((part) => part.type === "text");
					return new Text(text?.type === "text" ? text.text : "", 0, 0);
				}

				const { request, outcome } = details;
				let text: string;
				if (outcome.outcome.type === "response") {
					text = theme.fg(
						"success",
						outcome.outcome.responses.length === 1
							? `✓ Answered: ${outcome.outcome.responses[0].answer}`
							: `✓ ${outcome.outcome.responses.length} Responses submitted`,
					);
					if (!options.expanded)
						text += `  ${theme.fg("dim", keyHint("app.tools.expand", "for full details"))}`;
				} else if (outcome.outcome.type === "interruption") {
					text =
						theme.fg("warning", "↪ Left unanswered") +
						theme.fg("muted", " — continued normally");
				} else {
					text = theme.fg("warning", `⊘ Cancelled: ${outcome.outcome.reason}`);
				}

				if (options.expanded) {
					for (
						let questionIndex = 0;
						questionIndex < request.payload.questions.length;
						questionIndex++
					) {
						const question = request.payload.questions[questionIndex];
						const response =
							outcome.outcome.type === "response"
								? outcome.outcome.responses.find(
										(candidate) => candidate.questionId === question.id,
									)
								: undefined;
						text += `\n\n${theme.fg("text", `${questionIndex + 1}. ${question.question}`)}`;
						question.options.forEach((option, optionIndex) => {
							const selected =
								response?.kind === "choice" &&
								response.selectedIndex === optionIndex + 1;
							text += `\n   ${theme.fg(selected ? "success" : "dim", `${selected ? "●" : "○"} ${optionIndex + 1}. ${option.label}`)}`;
							if (option.description)
								text += `\n      ${theme.fg("muted", option.description)}`;
						});
						const custom = response?.kind === "custom" ? response.answer : "";
						text += `\n   ${theme.fg(custom ? "success" : "dim", `${custom ? "●" : "○"} ${question.options.length + 1}. Other${custom ? `: ${custom}` : ""}`)}`;
					}
				}
				return new Text(text, 0, 0);
			},
		});

		pi.registerCommand("q", {
			description:
				"Reopen this Agent Thread's active Question Interaction Request",
			handler: async (_args, ctx) => openQuestion(ctx),
		});
		pi.registerShortcut("alt+q", {
			description: "Reopen the active Question Interaction Request",
			handler: async (ctx) => openQuestion(ctx),
		});
		pi.on("session_start", (_event, ctx) => {
			useContext(ctx);
			const capabilities = (
				ctx as ExtensionContext & {
					capabilities?: {
						deferredToolBatches?: { protocolVersions?: readonly number[] };
					};
				}
			).capabilities;
			const supported = CORE_PROTOCOL_VERSIONS.every((version) =>
				capabilities?.deferredToolBatches?.protocolVersions?.includes(version),
			);
			if (!supported) {
				pi.setActiveTools(
					pi.getActiveTools().filter((name) => name !== "question"),
				);
				ctx.ui.notify(
					"Question Tool disabled: this Pi does not support the package's durable-deferral protocol.",
					"error",
				);
				return;
			}
			const snapshot = ctx.getDeferredBatch();
			activeRequestId =
				snapshot?.kind === "batch" ? snapshot.correlationId : undefined;
			const outcome = activeRequestId
				? createStore(pi, ctx).getOutcome(activeRequestId)
				: undefined;
			if (outcome) showRecoveryIndicator(ctx, outcome);
			else updatePendingIndicator(ctx);
		});
		pi.on("session_shutdown", (_event, ctx) => {
			clearIndicator(ctx);
			activeRequestId = undefined;
			currentContext = undefined;
		});
	};
}

export default createQuestionToolExtension();
