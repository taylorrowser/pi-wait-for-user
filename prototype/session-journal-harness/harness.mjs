#!/usr/bin/env node
/**
 * THROWAWAY compatibility harness for GitHub issue #11.
 *
 * It drives the SessionManager exported by an installed Pi release. The raw
 * tool_batch_deferred line is an intentionally unsupported stand-in for the
 * proposed future core entry, used only to test the journal substrate.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	DEFERRED_ENTRY,
	OUTCOME_ENTRY,
	REQUEST_ENTRY,
	classifyBranch,
	decideDeferral,
} from "./model.mjs";

const targetArgument = process.argv[2] ?? process.env.PI_PACKAGE;
if (!targetArgument) throw new Error("Usage: node harness.mjs <pi-coding-agent package root>");
const target = resolve(targetArgument);

const packageJsonPath = join(target, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const pi = await import(pathToFileURL(join(target, "dist/index.js")).href);
const { SessionManager, CURRENT_SESSION_VERSION } = pi;
if (typeof SessionManager !== "function") throw new Error(`${target} does not export SessionManager`);

const requireFromPi = createRequire(packageJsonPath);
const corePackageJsonPath = realpathSync(requireFromPi.resolve("@earendil-works/pi-agent-core/package.json"));
const coreRoot = dirname(corePackageJsonPath);
const coreEntry = join(coreRoot, "dist/index.js");
const core = await import(pathToFileURL(coreEntry).href);
const corePackage = JSON.parse(readFileSync(corePackageJsonPath, "utf8"));
const coreTypes = readFileSync(join(coreRoot, "dist/types.d.ts"), "utf8");

const root = await mkdtemp(join(tmpdir(), "pi-session-journal-harness-"));
const sessionDir = join(root, "sessions");
mkdirSync(sessionDir, { recursive: true });

const checks = [];
function check(name, condition, observed) {
	checks.push({ name, pass: Boolean(condition), observed });
}

function user(content) {
	return { role: "user", content, timestamp: Date.now() };
}

function assistant(calls) {
	return {
		role: "assistant",
		content: calls.map((call) => ({ type: "toolCall", ...call })),
		api: "anthropic-messages",
		provider: "prototype",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResult(call, text) {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		details: {},
		isError: false,
		timestamp: Date.now(),
	};
}

function appendRawDeferred(file, parentId, marker) {
	appendFileSync(
		file,
		`${JSON.stringify({
			type: DEFERRED_ENTRY,
			id: "de000001",
			parentId,
			timestamp: new Date().toISOString(),
			...marker,
		})}\n`,
	);
}

function snapshot(source, name) {
	const destination = join(root, `${name}.jsonl`);
	copyFileSync(source, destination);
	return destination;
}

function branch(file) {
	return SessionManager.open(file, sessionDir).getBranch();
}

function roles(manager) {
	return manager.buildSessionContext().messages.map((message) => message.role);
}

async function probeReload(sessionFile) {
	const eventLog = join(root, "reload-events.jsonl");
	const extensionFile = join(root, "reload-probe.ts");
	writeFileSync(
		extensionFile,
		`import { appendFileSync, statSync } from "node:fs";\n` +
			`const log = process.env.HARNESS_RELOAD_LOG!;\n` +
			`export default function (pi: any) {\n` +
			`  pi.on("session_start", (event: any, ctx: any) => { const file = ctx.sessionManager.getSessionFile(); appendFileSync(log, JSON.stringify({ event: "start", reason: event.reason, leafId: ctx.sessionManager.getLeafId(), bytes: file ? statSync(file).size : null }) + "\\n"); });\n` +
			`  pi.on("session_shutdown", (event: any) => appendFileSync(log, JSON.stringify({ event: "shutdown", reason: event.reason }) + "\\n"));\n` +
			`  pi.registerCommand("harness-reload", { handler: async (_args: string, ctx: any) => { await ctx.reload(); } });\n` +
			`}\n`,
	);

	const args = [
		join(target, "dist/cli.js"),
		"--mode",
		"rpc",
		"--session",
		sessionFile,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--extension",
		extensionFile,
	];
	const child = spawn(process.execPath, args, {
		cwd: root,
		env: { ...process.env, HARNESS_RELOAD_LOG: eventLog, PI_OFFLINE: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
	child.stdout.resume();
	child.stdin.end(`${JSON.stringify({ id: "reload", type: "prompt", message: "/harness-reload" })}\n`);

	let timeout;
	const exit = await Promise.race([
		new Promise((resolveExit) =>
			child.on("exit", (code, signal) => {
				clearTimeout(timeout);
				resolveExit({ code, signal });
			}),
		),
		new Promise((resolveTimeout) => {
			timeout = setTimeout(() => {
				child.kill("SIGKILL");
				resolveTimeout({ code: null, signal: "TIMEOUT" });
			}, 15_000);
		}),
	]);
	const events = readFileExists(eventLog)
		? readFileSync(eventLog, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
	return { exit, stderr: stderr.trim(), events };
}

const owner = { id: "call-question", name: "question", arguments: { question: "Ship?" } };
const sibling = { id: "call-read", name: "read", arguments: { path: "README.md" } };
const calls = [owner, sibling];
const registry = {
	question: {
		deferral: { protocolVersion: 1, handlerId: "question", handlerVersion: 1 },
	},
	read: {},
};
const requestId = "request:fixture:call-question";

try {
	let manager = SessionManager.create(root, sessionDir, { id: "00000000-0000-4000-8000-000000000011" });
	const file = manager.getSessionFile();
	const userId = manager.appendMessage(user("Use the Question Tool, then read README.md."));
	check("journal.defers-new-file-until-assistant", !readFileExists(file), "file absent after initial user message");
	const assistantId = manager.appendMessage(assistant(calls));
	check("journal.flushes-assistant-call-before-resolution", readFileExists(file), "file exists after assistant message");
	const afterAssistant = snapshot(file, "after-assistant");

	const contextBeforeControls = roles(manager);
	const requestEntryId = manager.appendCustomEntry(REQUEST_ENTRY, {
		version: 1,
		id: requestId,
		requestId,
		ownerCallId: owner.id,
	});
	const afterRequest = snapshot(file, "after-request");
	appendRawDeferred(file, requestEntryId, {
		version: 1,
		batchId: "batch:fixture",
		requestId,
		ownerCallId: owner.id,
		calls,
		protocolVersion: 1,
		handlerId: "question",
		handlerVersion: 1,
	});
	manager = SessionManager.open(file, sessionDir);
	const markerId = manager.getLeafId();
	const afterMarker = snapshot(file, "after-marker");

	check(
		"journal.control-entries-advance-leaf",
		requestEntryId !== assistantId && markerId === "de000001",
		{
			requestParentIsAssistant: manager.getEntry(requestEntryId)?.parentId === assistantId,
			markerBecameLeaf: markerId === "de000001",
		},
	);
	check(
		"context.control-entries-are-excluded",
		JSON.stringify(roles(manager)) === JSON.stringify(contextBeforeControls),
		{ before: contextBeforeControls, after: roles(manager) },
	);
	check(
		"journal.unknown-core-entry-survives-open",
		manager.getEntry(markerId)?.type === DEFERRED_ENTRY,
		manager.getEntry(markerId)?.type,
	);

	const boundaryStates = [];
	for (const [name, boundaryFile] of [
		["assistant", afterAssistant],
		["request", afterRequest],
		["marker", afterMarker],
	]) {
		boundaryStates.push({ name, state: classifyBranch(branch(boundaryFile), registry).state });
	}

	manager.appendCustomEntry(OUTCOME_ENTRY, {
		version: 1,
		requestId,
		outcome: { type: "response", answers: ["yes"] },
	});
	const afterOutcome = snapshot(file, "after-outcome");
	boundaryStates.push({ name: "outcome", state: classifyBranch(branch(afterOutcome), registry).state });

	manager.appendMessage(toolResult(owner, "User responded: yes"));
	const afterOwnerResult = snapshot(file, "after-owner-result");
	boundaryStates.push({ name: "owner-result", state: classifyBranch(branch(afterOwnerResult), registry).state });
	manager.appendMessage(toolResult(sibling, "README contents"));
	const afterAllResults = snapshot(file, "after-all-results");
	boundaryStates.push({ name: "all-results", state: classifyBranch(branch(afterAllResults), registry).state });

	const expectedBoundaryStates = [
		{ name: "assistant", state: "markerless_recovery" },
		{ name: "request", state: "markerless_recovery" },
		{ name: "marker", state: "waiting" },
		{ name: "outcome", state: "ready_to_resume" },
		{ name: "owner-result", state: "partial_resume" },
		{ name: "all-results", state: "complete" },
	];
	check(
		"recovery.classifies-every-complete-append-boundary",
		JSON.stringify(boundaryStates) === JSON.stringify(expectedBoundaryStates),
		boundaryStates,
	);

	const duplicateOutcomeFile = snapshot(afterOutcome, "duplicate-outcome");
	const duplicateOutcomeManager = SessionManager.open(duplicateOutcomeFile, sessionDir);
	duplicateOutcomeManager.appendCustomEntry(OUTCOME_ENTRY, {
		version: 1,
		requestId,
		outcome: { type: "cancellation", reason: "race-loser" },
	});
	const duplicateOutcomeState = classifyBranch(duplicateOutcomeManager.getBranch(), registry);
	check(
		"recovery.conflicting-terminal-outcomes-are-detectable",
		duplicateOutcomeState.state === "invalid_multiple_outcomes",
		duplicateOutcomeState,
	);

	const duplicateResultFile = snapshot(afterAllResults, "duplicate-result");
	const duplicateResultManager = SessionManager.open(duplicateResultFile, sessionDir);
	duplicateResultManager.appendMessage(toolResult(owner, "duplicate"));
	const duplicateResultState = classifyBranch(duplicateResultManager.getBranch(), registry);
	check(
		"recovery.duplicate-result-advancement-is-detectable",
		duplicateResultState.state === "invalid_duplicate_results",
		duplicateResultState,
	);

	const bytesBeforeOpen = readFileSync(afterMarker, "utf8");
	SessionManager.open(afterMarker, sessionDir);
	check(
		"resume.open-is-non-advancing",
		readFileSync(afterMarker, "utf8") === bytesBeforeOpen,
		"opening appended no bytes",
	);

	const reloadProbe = await probeReload(afterMarker);
	const reloadStarts = reloadProbe.events.filter((event) => event.event === "start");
	const startupState = reloadStarts.find((event) => event.reason === "startup");
	const reloadedState = reloadStarts.find((event) => event.reason === "reload");
	check(
		"reload.rebinds-without-advancing-session",
		reloadProbe.exit.code === 0 &&
			Boolean(startupState) &&
			Boolean(reloadedState) &&
			reloadedState.leafId === startupState.leafId &&
			reloadedState.bytes === startupState.bytes,
		{
			exit: reloadProbe.exit,
			lifecycle: reloadProbe.events.map((event) => `${event.event}:${event.reason}`),
			leafPreservedAcrossReload: reloadedState?.leafId === startupState?.leafId,
			journalBytesPreservedAcrossReload: reloadedState?.bytes === startupState?.bytes,
			stderr: reloadProbe.stderr,
		},
	);

	const unavailableStates = {
		missingOwner: classifyBranch(branch(afterMarker), { read: {} }),
		missingSibling: classifyBranch(branch(afterMarker), { question: registry.question }),
		wrongProtocol: classifyBranch(branch(afterMarker), {
			...registry,
			question: { deferral: { protocolVersion: 2, handlerId: "question", handlerVersion: 1 } },
		}),
		wrongHandler: classifyBranch(branch(afterMarker), {
			...registry,
			question: { deferral: { protocolVersion: 1, handlerId: "other", handlerVersion: 1 } },
		}),
	};
	check(
		"recovery.unavailable-is-recoverable-state",
		Object.values(unavailableStates).every((state) => state.state === "unavailable"),
		unavailableStates,
	);

	const queueDecision = decideDeferral({
		calls,
		registry,
		steering: ["steer one", "steer two"],
		followUp: ["follow one", "follow two"],
	});
	check(
		"queue.preexisting-input-prevents-waiting-and-drains-all",
		queueDecision.decision === "interrupt_before_waiting" &&
			queueDecision.provenance === "preexisting_user_input" &&
			queueDecision.drained.steering.length === 2 &&
			queueDecision.drained.followUp.length === 2,
		queueDecision,
	);
	const twoOwners = decideDeferral({
		calls: [owner, { ...sibling, name: "question" }],
		registry,
	});
	check("batch.multiple-deferral-owners-rejected", twoOwners.decision === "reject_multiple_owners", twoOwners);
	const oneOwner = decideDeferral({ calls, registry });
	check(
		"batch.one-owner-holds-entire-batch",
		oneOwner.decision === "append_deferred_marker" && oneOwner.heldCallIds.length === calls.length,
		oneOwner,
	);

	const agent = new core.Agent();
	agent.steer(user("queued steering"));
	agent.followUp(user("queued follow-up"));
	const queuedBeforeClear = agent.hasQueuedMessages();
	const serializedStateContainsQueue = /queued steering|queued follow-up/.test(JSON.stringify(agent.state));
	agent.clearAllQueues();
	check(
		"queue.current-pi-queues-are-memory-only",
		queuedBeforeClear && !serializedStateContainsQueue && !agent.hasQueuedMessages(),
		{ queuedBeforeClear, serializedStateContainsQueue, queuedAfterClear: agent.hasQueuedMessages() },
	);

	const alternateFile = snapshot(afterMarker, "tree-alternate");
	let alternate = SessionManager.open(alternateFile, sessionDir);
	alternate.branch(userId);
	alternate.appendMessage(user("Take another path."));
	const branchLocalState = classifyBranch(alternate.getBranch(), registry).state;
	const globalState = classifyBranch(alternate.getEntries(), registry).state;
	const reopenedAlternate = SessionManager.open(alternateFile, sessionDir);
	check(
		"tree.pending-state-is-branch-local",
		branchLocalState === "complete" && globalState === "waiting" && reopenedAlternate.getLeafId() === alternate.getLeafId(),
		{
			branchLocalState,
			globalState,
			reopenKeptLatestAppendedLeaf: reopenedAlternate.getLeafId() === alternate.getLeafId(),
		},
	);

	const cloneSource = snapshot(afterMarker, "clone-source");
	const cloneManager = SessionManager.open(cloneSource, sessionDir);
	const sourceSessionId = cloneManager.getSessionId();
	const cloneFile = cloneManager.createBranchedSession(markerId);
	const cloned = SessionManager.open(cloneFile, sessionDir);
	const clonedRequest = cloned
		.getBranch()
		.find((entry) => entry.type === "custom" && entry.customType === REQUEST_ENTRY)?.data;
	check(
		"clone.copies-pending-identities-verbatim",
		cloned.getSessionId() !== sourceSessionId && clonedRequest?.requestId === requestId && cloned.getEntry(markerId)?.type === DEFERRED_ENTRY,
		{
			sessionIdChanged: cloned.getSessionId() !== sourceSessionId,
			requestIdCopied: clonedRequest?.requestId,
			markerEntryIdCopied: Boolean(cloned.getEntry(markerId)),
		},
	);

	const forkSource = snapshot(afterMarker, "fork-source");
	const forkManager = SessionManager.open(forkSource, sessionDir);
	const forkFile = forkManager.createBranchedSession(userId);
	const forked = SessionManager.open(forkFile, sessionDir);
	check(
		"fork.cut-before-deferred-batch-does-not-copy-waiting-state",
		classifyBranch(forked.getBranch(), registry).state === "complete",
		classifyBranch(forked.getBranch(), registry),
	);

	const newManager = SessionManager.open(afterMarker, sessionDir);
	const oldSessionId = newManager.getSessionId();
	newManager.newSession({ parentSession: afterMarker });
	check(
		"new.starts-unaffiliated-empty-session",
		newManager.getSessionId() !== oldSessionId && newManager.getEntries().length === 0,
		{ sessionIdChanged: newManager.getSessionId() !== oldSessionId, entryCount: newManager.getEntries().length },
	);

	const compactUnsafeFile = snapshot(afterMarker, "compact-unsafe");
	let compactUnsafe = SessionManager.open(compactUnsafeFile, sessionDir);
	compactUnsafe.appendCompaction("Earlier context.", markerId, 100);
	compactUnsafe.appendCustomEntry(OUTCOME_ENTRY, {
		version: 1,
		requestId,
		outcome: { type: "response", answers: ["yes"] },
	});
	compactUnsafe.appendMessage(toolResult(owner, "User responded: yes"));
	compactUnsafe.appendMessage(toolResult(sibling, "README contents"));
	const unsafeRoles = roles(compactUnsafe);
	const compactPinnedFile = snapshot(afterMarker, "compact-pinned");
	let compactPinned = SessionManager.open(compactPinnedFile, sessionDir);
	compactPinned.appendCompaction("Earlier context.", assistantId, 100);
	const pinnedRoles = roles(compactPinned);
	check(
		"compaction.deferred-assistant-must-be-pinned",
		!unsafeRoles.includes("assistant") && unsafeRoles.includes("toolResult") && pinnedRoles.includes("assistant"),
		{ withoutPin: unsafeRoles, withPin: pinnedRoles },
	);

	const tornFile = snapshot(afterAssistant, "torn-tail");
	appendFileSync(tornFile, '{"type":"custom"');
	let torn = SessionManager.open(tornFile, sessionDir);
	torn.appendCustomEntry(REQUEST_ENTRY, { requestId });
	torn = SessionManager.open(tornFile, sessionDir);
	const requestSurvivedTornTail = torn
		.getEntries()
		.some((entry) => entry.type === "custom" && entry.customType === REQUEST_ENTRY);
	check(
		"journal.torn-tail-poisons-next-append",
		requestSurvivedTornTail === false,
		{ requestSurvivedTornTail },
	);

	const beforeToolCallHasDefer = /interface BeforeToolCallResult\s*{[^}]*\bdefer\??\s*:/s.test(coreTypes);
	check(
		"capability.current-core-has-no-defer-result",
		beforeToolCallHasDefer === false,
		{ beforeToolCallHasDefer },
	);

	const report = {
		target: {
			package: packageJson.name,
			version: packageJson.version,
			agentCoreVersion: corePackage.version,
			sessionVersion: CURRENT_SESSION_VERSION,
		},
		summary: {
			passed: checks.filter((item) => item.pass).length,
			failed: checks.filter((item) => !item.pass).length,
		},
		checks,
		findings: [
			"A first-class unknown control entry survives open, branching, cloning, and context reconstruction, but every control entry advances the active leaf.",
			"Complete append boundaries are sufficient to reconstruct markerless, waiting, ready, partial, complete, and unavailable states from one JSONL branch.",
			"Compaction must pin the deferred assistant batch until every matching tool result is recorded; otherwise resumed results become orphaned in model context.",
			"Current clone mechanics copy call, request, marker, and entry identities verbatim into a new session id; affiliation policy cannot be inferred from SessionManager.",
			"Current queue state is memory-only. The proposed transition must inspect and drain all pre-marker steering and follow-up input before recording stable Waiting State.",
			"Current JSONL loading skips a torn final line but does not truncate it, so the next append is concatenated onto the malformed tail and is also lost on reopen.",
			"SessionManager itself does not provide durable deferral, idempotent result advancement, or a typed append API for the proposed core entry.",
		],
	};

	const reportsDir = process.env.PI_HARNESS_REPORT_DIR
		? resolve(process.env.PI_HARNESS_REPORT_DIR)
		: join(dirname(fileURLToPath(import.meta.url)), "reports");
	mkdirSync(reportsDir, { recursive: true });
	const reportPath = join(reportsDir, process.env.PI_HARNESS_REPORT_NAME ?? `pi-${packageJson.version}.json`);
	writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

	for (const item of checks) console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}`);
	console.log(`\n${report.summary.passed} passed, ${report.summary.failed} failed`);
	console.log(`Report: ${reportPath}`);
	if (report.summary.failed > 0) process.exitCode = 1;
} finally {
	await rm(root, { recursive: true, force: true });
}

function readFileExists(path) {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}
