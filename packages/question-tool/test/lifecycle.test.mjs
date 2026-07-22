import assert from "node:assert/strict";
import test from "node:test";

import {
	createQuestionLifecycleStore,
	QuestionResponseValidationError,
} from "../src/lifecycle.ts";

function createHarness(entries = []) {
	return {
		entries,
		store: createQuestionLifecycleStore({
			getBranch: () => entries,
			appendEntry(customType, data) {
				entries.push({ type: "custom", customType, data });
			},
		}),
	};
}

const request = {
	version: 1,
	requestId: "question:assistant-1:call-1",
	assistantEntryId: "assistant-1",
	ownerCallId: "call-1",
	payload: {
		questions: [
			{
				id: "environment",
				label: "Environment",
				question: "Where should this deploy?",
				options: [{ label: "Staging" }, { label: "Production" }],
			},
			{
				id: "speed",
				label: "Speed",
				question: "How quickly?",
				options: [{ label: "Carefully" }, { label: "Quickly" }],
			},
		],
	},
};

test("records one complete typed Response before exposing it as the winning outcome", () => {
	const { store } = createHarness([
		{
			type: "custom",
			customType: "dev.taylorrowser.pi-question-tool/request",
			data: request,
		},
	]);

	const result = store.respond(request.requestId, [
		{
			questionId: "environment",
			answer: "Staging",
			kind: "choice",
			selectedIndex: 1,
		},
		{ questionId: "speed", answer: "Take two weeks", kind: "custom" },
	]);

	assert.equal(result.status, "recorded");
	assert.deepEqual(store.getOutcome(request.requestId)?.outcome, {
		type: "response",
		responses: [
			{
				questionId: "environment",
				answer: "Staging",
				kind: "choice",
				selectedIndex: 1,
			},
			{ questionId: "speed", answer: "Take two weeks", kind: "custom" },
		],
	});
});

test("rejects a partial Response without appending a terminal outcome", () => {
	const { entries, store } = createHarness([
		{
			type: "custom",
			customType: "dev.taylorrowser.pi-question-tool/request",
			data: request,
		},
	]);

	assert.throws(
		() =>
			store.respond(request.requestId, [
				{
					questionId: "environment",
					answer: "Staging",
					kind: "choice",
					selectedIndex: 1,
				},
			]),
		QuestionResponseValidationError,
	);
	assert.equal(entries.length, 1);
});

test("reports an incompatible persisted package outcome instead of treating it as pending", () => {
	const { store } = createHarness([
		{
			type: "custom",
			customType: "dev.taylorrowser.pi-question-tool/request",
			data: request,
		},
		{
			type: "custom",
			customType: "dev.taylorrowser.pi-question-tool/outcome",
			data: {
				version: 2,
				requestId: request.requestId,
				outcome: { type: "response", responses: [] },
			},
		},
	]);

	assert.equal(store.hasIncompatibleOutcome(request.requestId), true);
	assert.equal(store.getOutcome(request.requestId), undefined);
});

test("the first terminal outcome wins", () => {
	const { entries, store } = createHarness([
		{
			type: "custom",
			customType: "dev.taylorrowser.pi-question-tool/request",
			data: request,
		},
	]);

	store.interrupt(request.requestId, "new_user_prompt");
	const result = store.cancel(request.requestId, "abandoned");
	const lateResponse = store.respond(request.requestId, []);

	assert.equal(result.status, "conflict");
	assert.equal(result.outcome.outcome.type, "interruption");
	assert.equal(lateResponse.status, "conflict");
	assert.equal(lateResponse.outcome.outcome.type, "interruption");
	assert.equal(entries.length, 2);
});
