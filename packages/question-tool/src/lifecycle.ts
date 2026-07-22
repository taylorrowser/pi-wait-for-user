import {
	OUTCOME_ENTRY_TYPE,
	PACKAGE_SCHEMA_VERSION,
	type QuestionDefinition,
	REQUEST_ENTRY_TYPE,
} from "./contracts.ts";

export interface QuestionRequestRecord {
	version: typeof PACKAGE_SCHEMA_VERSION;
	requestId: string;
	assistantEntryId: string;
	ownerCallId: string;
	payload: { questions: QuestionDefinition[] };
}

export type QuestionResponse =
	| {
			questionId: string;
			answer: string;
			kind: "choice";
			selectedIndex: number;
	  }
	| { questionId: string; answer: string; kind: "custom" };

export type QuestionOutcome =
	| { type: "response"; responses: QuestionResponse[] }
	| {
			type: "interruption";
			provenance: "new_user_prompt" | "preexisting_user_input";
	  }
	| { type: "cancellation"; reason: string };

export interface QuestionOutcomeRecord {
	version: typeof PACKAGE_SCHEMA_VERSION;
	requestId: string;
	outcome: QuestionOutcome;
}

export type RecordQuestionOutcomeResult =
	| { status: "recorded"; outcome: QuestionOutcomeRecord }
	| { status: "conflict"; outcome: QuestionOutcomeRecord };

interface CustomEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface QuestionLifecycleAdapter {
	getBranch(): CustomEntryLike[];
	appendEntry(customType: string, data: unknown): void;
}

export class QuestionResponseValidationError extends Error {
	override readonly name = "QuestionResponseValidationError";
}

function customData<T>(
	entry: CustomEntryLike,
	customType: string,
): T | undefined {
	return entry.type === "custom" && entry.customType === customType
		? (entry.data as T)
		: undefined;
}

function isRequestRecord(value: unknown): value is QuestionRequestRecord {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<QuestionRequestRecord>;
	if (
		request.version !== PACKAGE_SCHEMA_VERSION ||
		typeof request.requestId !== "string" ||
		typeof request.assistantEntryId !== "string" ||
		typeof request.ownerCallId !== "string" ||
		!Array.isArray(request.payload?.questions) ||
		request.payload.questions.length === 0
	) {
		return false;
	}
	const ids = new Set<string>();
	return request.payload.questions.every((question) => {
		if (
			!question ||
			typeof question.id !== "string" ||
			!question.id ||
			ids.has(question.id) ||
			typeof question.label !== "string" ||
			typeof question.question !== "string" ||
			!question.question ||
			!Array.isArray(question.options) ||
			question.options.length === 0 ||
			!question.options.every(
				(option) =>
					typeof option?.label === "string" &&
					option.label.length > 0 &&
					(option.description === undefined ||
						typeof option.description === "string"),
			)
		) {
			return false;
		}
		ids.add(question.id);
		return true;
	});
}

function isOutcomeRecord(value: unknown): value is QuestionOutcomeRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<QuestionOutcomeRecord>;
	if (
		record.version !== PACKAGE_SCHEMA_VERSION ||
		typeof record.requestId !== "string" ||
		!record.outcome
	) {
		return false;
	}
	const outcome = record.outcome;
	if (outcome.type === "response") {
		return (
			Array.isArray(outcome.responses) &&
			outcome.responses.every(
				(response) =>
					typeof response.questionId === "string" &&
					typeof response.answer === "string" &&
					(response.kind === "custom" ||
						(response.kind === "choice" &&
							Number.isInteger(response.selectedIndex) &&
							response.selectedIndex > 0)),
			)
		);
	}
	if (outcome.type === "interruption") {
		return (
			outcome.provenance === "new_user_prompt" ||
			outcome.provenance === "preexisting_user_input"
		);
	}
	return outcome.type === "cancellation" && typeof outcome.reason === "string";
}

function validateResponses(
	request: QuestionRequestRecord,
	responses: QuestionResponse[],
): QuestionResponse[] {
	const byQuestion = new Map<string, QuestionResponse>();
	for (const response of responses) {
		if (byQuestion.has(response.questionId)) {
			throw new QuestionResponseValidationError(
				`Duplicate Response for question ${response.questionId}`,
			);
		}
		byQuestion.set(response.questionId, response);
	}

	if (responses.length !== request.payload.questions.length) {
		throw new QuestionResponseValidationError(
			"Every question requires exactly one Response",
		);
	}

	return request.payload.questions.map((question) => {
		const response = byQuestion.get(question.id);
		if (!response)
			throw new QuestionResponseValidationError(
				`Missing Response for question ${question.id}`,
			);
		const answer = response.answer.trim();
		if (!answer)
			throw new QuestionResponseValidationError(
				`Response for question ${question.id} is empty`,
			);

		if (response.kind === "choice") {
			const option = question.options[response.selectedIndex - 1];
			if (!option || option.label !== answer) {
				throw new QuestionResponseValidationError(
					`Response for question ${question.id} is not a supplied choice`,
				);
			}
			return { ...response, answer };
		}

		return { questionId: response.questionId, answer, kind: "custom" };
	});
}

export interface QuestionLifecycleStore {
	getRequest(requestId: string): QuestionRequestRecord | undefined;
	getRequestByOwner(
		assistantEntryId: string,
		ownerCallId: string,
	): QuestionRequestRecord | undefined;
	getOutcome(requestId: string): QuestionOutcomeRecord | undefined;
	getOutcomes(requestId: string): QuestionOutcomeRecord[];
	hasIncompatibleOutcome(requestId: string): boolean;
	respond(
		requestId: string,
		responses: QuestionResponse[],
	): RecordQuestionOutcomeResult;
	interrupt(
		requestId: string,
		provenance: "new_user_prompt" | "preexisting_user_input",
	): RecordQuestionOutcomeResult;
	cancel(requestId: string, reason: string): RecordQuestionOutcomeResult;
}

export function createQuestionLifecycleStore(
	adapter: QuestionLifecycleAdapter,
): QuestionLifecycleStore {
	const requests = (): QuestionRequestRecord[] =>
		adapter
			.getBranch()
			.map((entry) => customData<unknown>(entry, REQUEST_ENTRY_TYPE))
			.filter(isRequestRecord);
	const rawOutcomes = (): unknown[] =>
		adapter
			.getBranch()
			.map((entry) => customData<unknown>(entry, OUTCOME_ENTRY_TYPE))
			.filter((outcome) => outcome !== undefined);
	const outcomes = (): QuestionOutcomeRecord[] =>
		rawOutcomes().filter(isOutcomeRecord);

	const getRequest = (requestId: string): QuestionRequestRecord | undefined =>
		requests().find((request) => request.requestId === requestId);
	const getOutcome = (requestId: string): QuestionOutcomeRecord | undefined =>
		outcomes().find((outcome) => outcome.requestId === requestId);

	const record = (
		requestId: string,
		outcome: QuestionOutcome,
	): RecordQuestionOutcomeResult => {
		const existing = getOutcome(requestId);
		if (existing) return { status: "conflict", outcome: existing };
		if (!getRequest(requestId))
			throw new Error(
				`Question Interaction Request ${requestId} was not found`,
			);
		const entry: QuestionOutcomeRecord = {
			version: PACKAGE_SCHEMA_VERSION,
			requestId,
			outcome,
		};
		adapter.appendEntry(OUTCOME_ENTRY_TYPE, entry);
		return { status: "recorded", outcome: entry };
	};

	return {
		getRequest,
		getRequestByOwner: (assistantEntryId, ownerCallId) =>
			requests().find(
				(request) =>
					request.assistantEntryId === assistantEntryId &&
					request.ownerCallId === ownerCallId,
			),
		getOutcome,
		getOutcomes: (requestId) =>
			outcomes().filter((outcome) => outcome.requestId === requestId),
		hasIncompatibleOutcome: (requestId) =>
			rawOutcomes().some(
				(outcome) =>
					Boolean(
						outcome &&
							typeof outcome === "object" &&
							(outcome as { requestId?: unknown }).requestId === requestId,
					) && !isOutcomeRecord(outcome),
			),
		respond(requestId, responses) {
			const existing = getOutcome(requestId);
			if (existing) return { status: "conflict", outcome: existing };
			const request = getRequest(requestId);
			if (!request)
				throw new Error(
					`Question Interaction Request ${requestId} was not found`,
				);
			return record(requestId, {
				type: "response",
				responses: validateResponses(request, responses),
			});
		},
		interrupt: (requestId, provenance) =>
			record(requestId, { type: "interruption", provenance }),
		cancel: (requestId, reason) =>
			record(requestId, { type: "cancellation", reason }),
	};
}
