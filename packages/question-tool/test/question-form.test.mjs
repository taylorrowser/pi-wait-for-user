import assert from "node:assert/strict";
import test from "node:test";

import { showQuestionForm } from "../src/question-form.ts";

const key = {
	down: "\u001b[B",
	enter: "\r",
	escape: "\u001b",
	left: "\u001b[D",
	right: "\u001b[C",
	up: "\u001b[A",
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

test("Up Arrow leaves custom editing and returns to the preceding option", async () => {
	const form = openForm(oneQuestion);

	form.component.handleInput(key.down);
	form.component.handleInput("draft answer");
	form.component.handleInput(key.up);

	const rendered = form.component.render(80).join("\n");
	assert.match(rendered, /draft answer/);
	assert.match(rendered, /↑↓ choices/);

	form.component.handleInput(key.enter);
	assert.deepEqual(form.result, [
		{
			questionId: "environment",
			answer: "Staging",
			kind: "choice",
			selectedIndex: 1,
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

test("submitting a custom answer after backward navigation preserves the next question's choice", async () => {
	const questions = [
		{
			id: "environment",
			label: "Environment",
			question: "Where should this deploy?",
			options: [{ label: "Staging" }],
		},
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
	form.component.handleInput(key.left);
	form.component.handleInput(key.left);
	form.component.handleInput(key.down);
	form.component.handleInput("Production");
	form.component.handleInput(key.enter);
	form.component.handleInput(key.right);
	form.component.handleInput(key.enter);

	assert.deepEqual(form.result, [
		{
			questionId: "environment",
			answer: "Production",
			kind: "custom",
		},
		{
			questionId: "speed",
			answer: "Carefully",
			kind: "choice",
			selectedIndex: 1,
		},
	]);
	await form.pending;
});

test("Escape from navigation dismisses presentation without creating a Response", async () => {
	const form = openForm(oneQuestion);
	form.component.handleInput(key.escape);
	assert.equal(form.result, null);
	await form.pending;
});
