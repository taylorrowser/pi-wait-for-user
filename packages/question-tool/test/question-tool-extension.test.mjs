import assert from "node:assert/strict";
import test from "node:test";

import { createQuestionToolExtension } from "../src/index.ts";

const identityTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

const question = {
	id: "environment",
	label: "Environment",
	question: "Where should this deploy?",
	options: [{ label: "Staging" }],
};

function request(number) {
	return {
		version: 1,
		requestId: `question:assistant-${number}:call-${number}`,
		assistantEntryId: `assistant-${number}`,
		ownerCallId: `call-${number}`,
		payload: { questions: [{ ...question, question: `Question ${number}?` }] },
	};
}

function deferredBatch(interactionRequest) {
	return {
		kind: "batch",
		sessionId: "session-1",
		assistantEntryId: interactionRequest.assistantEntryId,
		ownerCallId: interactionRequest.ownerCallId,
		calls: [
			{
				toolCallId: interactionRequest.ownerCallId,
				toolName: "question",
				result: "missing",
			},
		],
		phase: "deferred",
		correlationId: interactionRequest.requestId,
		availability: { status: "available" },
	};
}

function createHarness(requests) {
	const entries = requests.map((interactionRequest) => ({
		type: "custom",
		customType: "dev.taylorrowser.pi-question-tool/request",
		data: interactionRequest,
	}));
	const components = [];
	let activeBatch;
	let registeredTool;
	let resumeCalls = 0;
	let resolveResume;
	let widgetCalls = 0;
	const resume = new Promise((resolve) => {
		resolveResume = resolve;
	});
	const ui = {
		custom(factory) {
			return new Promise((resolve) => {
				const component = factory(
					{ requestRender() {} },
					identityTheme,
					{},
					resolve,
				);
				components.push(component);
			});
		},
		notify() {},
		setStatus() {},
		setWidget() {
			widgetCalls++;
		},
	};
	const ctx = {
		mode: "tui",
		ui,
		getDeferredBatch: () => activeBatch,
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => "session-1",
		},
	};
	const pi = {
		appendEntry(customType, data) {
			entries.push({ type: "custom", customType, data });
		},
		registerTool(tool) {
			registeredTool = tool;
		},
		registerCommand() {},
		registerShortcut() {},
		on() {},
		resumeDeferred() {
			resumeCalls++;
			return resume;
		},
	};

	createQuestionToolExtension()(pi);

	return {
		addRequest(interactionRequest) {
			entries.push({
				type: "custom",
				customType: "dev.taylorrowser.pi-question-tool/request",
				data: interactionRequest,
			});
		},
		components,
		ctx,
		get resumeCalls() {
			return resumeCalls;
		},
		resolveResume,
		setActiveBatch(batch) {
			activeBatch = batch;
		},
		tool: registeredTool,
		get widgetCalls() {
			return widgetCalls;
		},
		summaryText(batch) {
			return registeredTool.deferral.summary(batch, {
				cwd: "/project",
				sessionManager: ctx.sessionManager,
			});
		},
	};
}

async function waitFor(predicate) {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail("Timed out waiting for extension state");
}

test("package presentation does not open for an unavailable deferred batch", async () => {
	const interactionRequest = request(1);
	const batch = {
		...deferredBatch(interactionRequest),
		availability: { status: "unavailable", message: "Package is incompatible" },
	};
	const harness = createHarness([interactionRequest]);
	harness.setActiveBatch(batch);

	await harness.tool.deferral.presenter(batch, harness.ctx);

	assert.equal(harness.components.length, 0);
});

test("a completed resume cannot replace a newer Question Interaction Request's presentation", async () => {
	const firstRequest = request(1);
	const secondRequest = request(2);
	const firstBatch = deferredBatch(firstRequest);
	const secondBatch = deferredBatch(secondRequest);
	const harness = createHarness([firstRequest]);

	harness.setActiveBatch(firstBatch);
	const firstPresentation = harness.tool.deferral.presenter(
		firstBatch,
		harness.ctx,
	);
	await waitFor(() => harness.components.length === 1);
	harness.components[0].handleInput("\r");
	await firstPresentation;
	assert.equal(harness.resumeCalls, 1);

	harness.addRequest(secondRequest);
	harness.setActiveBatch(secondBatch);
	const secondPresentation = harness.tool.deferral.presenter(
		secondBatch,
		harness.ctx,
	);
	await waitFor(() => harness.components.length === 2);

	harness.resolveResume({ status: "still_deferred", deferredBatch: secondBatch });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(harness.widgetCalls, 0);

	harness.components[1].handleInput("\u001b");
	await secondPresentation;
	assert.equal(await harness.summaryText(secondBatch), "1 question needs a Response");
	assert.equal(harness.widgetCalls, 0);
});

test("a completed resume still shows recovery for the recorded Interaction Request", async () => {
	const firstRequest = request(1);
	const firstBatch = deferredBatch(firstRequest);
	const harness = createHarness([firstRequest]);

	harness.setActiveBatch(firstBatch);
	const presentation = harness.tool.deferral.presenter(firstBatch, harness.ctx);
	await waitFor(() => harness.components.length === 1);
	harness.components[0].handleInput("\r");
	await presentation;

	harness.resolveResume({ status: "still_deferred", deferredBatch: firstBatch });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(
		await harness.summaryText(firstBatch),
		"Question outcome recorded; deferred work remains",
	);
	assert.equal(harness.widgetCalls, 0);
});
