import assert from "node:assert/strict";
import test from "node:test";

import { showQuestionForm } from "../src/question-form.ts";

const key = {
	down: "\u001b[B",
	enter: "\r",
	escape: "\u001b",
};

const identityTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

function openForm(questions) {
	let component;
	let result;
	const ctx = {
		mode: "tui",
		ui: {
			custom(factory) {
				return new Promise((resolve) => {
					component = factory(
						{ requestRender() {} },
						identityTheme,
						{},
						(value) => {
							result = value;
							resolve(value);
						},
					);
				});
			},
		},
	};
	const pending = showQuestionForm(ctx, questions);
	return {
		get component() {
			return component;
		},
		get result() {
			return result;
		},
		pending,
	};
}

const oneQuestion = [
	{
		id: "environment",
		label: "Environment",
		question: "Where should this deploy?",
		options: [{ label: "Staging" }],
	},
];

test("Escape leaves custom editing without deleting the in-form draft, and a single question submits directly", async () => {
	const form = openForm(oneQuestion);

	form.component.handleInput(key.down);
	form.component.handleInput("draft answer");
	form.component.handleInput(key.escape);
	form.component.handleInput(key.enter);

	assert.deepEqual(form.result, [
		{
			questionId: "environment",
			answer: "draft answer",
			kind: "custom",
		},
	]);
	await form.pending;
});

test("a question set requires a separate Review & Submit confirmation", async () => {
	const questions = [
		...oneQuestion,
		{
			id: "speed",
			label: "Speed",
			question: "How quickly?",
			options: [{ label: "Carefully" }],
		},
	];
	const form = openForm(questions);

	form.component.handleInput(key.enter);
	form.component.handleInput(key.enter);
	assert.equal(form.result, undefined);
	form.component.handleInput(key.enter);

	assert.equal(form.result.length, 2);
	await form.pending;
});

test("Escape from navigation dismisses presentation without creating a Response", async () => {
	const form = openForm(oneQuestion);
	form.component.handleInput(key.escape);
	assert.equal(form.result, null);
	await form.pending;
});
