import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createEventBus,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { OUTCOME_ENTRY_TYPE, REQUEST_ENTRY_TYPE } from "../src/contracts.ts";
import { createQuestionToolExtension } from "../src/index.ts";

async function createHarness({ root, sessionManager, controller, faux } = {}) {
	root ??= mkdtempSync(join(tmpdir(), "pi-question-tool-"));
	faux ??= fauxProvider();
	controller ??= {};
	const eventBus = createEventBus();
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: join(root, "agent"),
		settingsManager,
		eventBus,
		extensionFactories: [createQuestionToolExtension(controller)],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const result = await createAgentSession({
		cwd: root,
		agentDir: join(root, "agent"),
		model: faux.getModel(),
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager:
			sessionManager ?? SessionManager.create(root, join(root, "sessions")),
		tools: ["question"],
	});
	result.session.subscribe(() => {});
	return { root, faux, controller, eventBus, session: result.session };
}

function dispose(harness, removeRoot = true) {
	harness.session.dispose();
	harness.eventBus.clear();
	if (removeRoot) rmSync(harness.root, { recursive: true, force: true });
}

const questions = {
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
};

async function defer(harness) {
	harness.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("question", questions, { id: "question-1" }),
			{
				stopReason: "toolUse",
			},
		),
	]);
	await harness.session.prompt("Ask before deploying");
}

test("opening a saved Agent Thread reconstructs its Question Interaction Request without advancing it", async () => {
	const initial = await createHarness();
	let reopened;
	try {
		await defer(initial);
		const sessionFile = initial.session.sessionFile;
		assert.ok(sessionFile);
		const root = initial.root;
		dispose(initial, false);

		reopened = await createHarness({
			root,
			sessionManager: SessionManager.open(sessionFile),
			controller: {},
		});
		assert.equal(reopened.session.deferredBatch?.phase, "deferred");
		assert.equal(
			reopened.controller.getActiveRequest()?.payload.questions[0].id,
			"environment",
		);
		assert.equal(
			reopened.session.messages.filter(
				(message) => message.role === "toolResult",
			).length,
			0,
		);
	} finally {
		if (reopened) dispose(reopened);
		else if (initial.session.sessionFile) dispose(initial);
	}
});

test("the package provides privacy-safe short text for core-owned deferred re-entry", async () => {
	const harness = await createHarness();
	try {
		await defer(harness);
		const snapshot = harness.session.deferredBatch;
		const summary = harness.session.getToolDefinition("question")?.deferral?.summary;
		assert.equal(snapshot?.kind, "batch");
		assert.equal(typeof summary, "function");
		assert.equal(
			await summary(snapshot, {
				cwd: harness.root,
				sessionManager: harness.session.sessionManager,
			}),
			"2 questions need Responses",
		);
	} finally {
		dispose(harness);
	}
});

test("a typed package Response survives the durable boundary and resumes the original Question Tool call", async () => {
	const harness = await createHarness();
	try {
		await defer(harness);
		assert.equal(harness.session.deferredBatch?.kind, "batch");
		assert.equal(harness.session.deferredBatch?.phase, "deferred");

		const request = harness.controller.getActiveRequest();
		assert.equal(request?.payload.questions.length, 2);
		const recorded = harness.controller.respond(request.requestId, [
			{
				questionId: "environment",
				answer: "Staging",
				kind: "choice",
				selectedIndex: 1,
			},
			{ questionId: "speed", answer: "Over two weeks", kind: "custom" },
		]);
		assert.equal(recorded.status, "recorded");

		harness.faux.setResponses([
			fauxAssistantMessage("Continuing after the complete Response set."),
		]);
		const result = await harness.session.resumeDeferred();
		assert.equal(result.status, "advanced");
		assert.equal(harness.session.deferredBatch, undefined);

		const toolResult = harness.session.messages.find(
			(message) =>
				message.role === "toolResult" && message.toolCallId === "question-1",
		);
		assert.equal(toolResult?.role, "toolResult");
		assert.match(
			toolResult.content[0].text,
			/environment: selected 1\. Staging/,
		);
		assert.match(toolResult.content[0].text, /speed: wrote Over two weeks/);

		const branch = harness.session.sessionManager.getBranch();
		assert.equal(
			branch.filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "dev.taylorrowser.pi-question-tool/draft",
			).length,
			0,
		);
		const requestIndex = branch.findIndex(
			(entry) =>
				entry.type === "custom" && entry.customType === REQUEST_ENTRY_TYPE,
		);
		const markerIndex = branch.findIndex(
			(entry) => entry.type === "tool_batch_deferred",
		);
		const outcomeIndex = branch.findIndex(
			(entry) =>
				entry.type === "custom" && entry.customType === OUTCOME_ENTRY_TYPE,
		);
		const resultIndex = branch.findIndex(
			(entry) =>
				entry.type === "message" && entry.message.role === "toolResult",
		);
		assert.ok(requestIndex >= 0 && requestIndex < markerIndex);
		assert.ok(markerIndex < outcomeIndex && outcomeIndex < resultIndex);
	} finally {
		dispose(harness);
	}
});

test("an ordinary message records Interruption and produces a package-owned Left unanswered result", async () => {
	const harness = await createHarness();
	try {
		await defer(harness);
		harness.faux.setResponses([
			fauxAssistantMessage("Continuing with the user's new direction."),
		]);
		await harness.session.prompt("Continue without answering");

		assert.equal(harness.session.deferredBatch, undefined);
		const outcome = harness.controller.getOutcome(
			harness.session.messages.find((message) => message.role === "toolResult")
				?.details.outcome.requestId,
		);
		assert.equal(outcome?.outcome.type, "interruption");
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult",
		);
		assert.equal(result?.content[0].text, "Left unanswered");
	} finally {
		dispose(harness);
	}
});

test("a programmatic Cancellation is durable before abandonment advances the Agent Thread", async () => {
	const harness = await createHarness();
	try {
		await defer(harness);
		const request = harness.controller.getActiveRequest();
		assert.equal(
			harness.controller.cancel(request.requestId, "declined").status,
			"recorded",
		);
		harness.faux.setResponses([
			fauxAssistantMessage("Continuing after Cancellation."),
		]);

		const result = await harness.session.abandonDeferred();
		assert.equal(result.status, "advanced");
		const toolResult = harness.session.messages.find(
			(message) => message.role === "toolResult",
		);
		assert.equal(toolResult?.content[0].text, "Cancelled: declined");
	} finally {
		dispose(harness);
	}
});
