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
	let widget;
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
		setWidget(_key, content) {
			widget = content;
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
		widgetText() {
			if (!widget) return undefined;
			return widget({}, identityTheme).render(120).join("\n");
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
	assert.equal(harness.widgetText(), undefined);

	harness.components[1].handleInput("\u001b");
	await secondPresentation;
	assert.match(harness.widgetText(), /Alt\+Q or \/q to open/);
	assert.doesNotMatch(harness.widgetText(), /Response recorded/);
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
	assert.match(harness.widgetText(), /Response recorded; deferred work remains/);
	assert.match(harness.widgetText(), /Run \/deferred/);
});
