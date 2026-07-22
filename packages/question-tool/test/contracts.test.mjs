import assert from "node:assert/strict";
import test from "node:test";

import { normalizeQuestionSet } from "../src/contracts.ts";

test("normalizes one Interaction Request and folds model custom placeholders into the package row", () => {
	const questions = normalizeQuestionSet({
		questions: [
			{
				id: "environment",
				question: "Where should this deploy?",
				options: [
					{ label: "Staging", description: "The shared test environment" },
					{ label: "Other (please specify)" },
				],
			},
		],
	});

	assert.deepEqual(questions, [
		{
			id: "environment",
			label: "Q1",
			question: "Where should this deploy?",
			options: [
				{ label: "Staging", description: "The shared test environment" },
			],
		},
	]);
});

test("rejects duplicate question identities in one Interaction Request", () => {
	assert.throws(
		() =>
			normalizeQuestionSet({
				questions: [
					{ id: "scope", question: "First?", options: [{ label: "A" }] },
					{ id: "scope", question: "Second?", options: [{ label: "B" }] },
				],
			}),
		/Question id must be unique: scope/,
	);
});

test("rejects a question that contains only model custom placeholders", () => {
	assert.throws(
		() =>
			normalizeQuestionSet({
				questions: [
					{
						id: "scope",
						question: "Which?",
						options: [{ label: "Custom answer" }],
					},
				],
			}),
		/must provide at least one concrete supplied choice/,
	);
});
