// THROWAWAY PROTOTYPE MODEL for GitHub issue #11.
// Pure journal classification logic; this is not a proposed production API.

export const REQUEST_ENTRY = "interaction_request";
export const OUTCOME_ENTRY = "interaction_outcome";
export const DEFERRED_ENTRY = "tool_batch_deferred";

function toolCalls(message) {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.filter((part) => part?.type === "toolCall");
}

function resultCallIds(entries) {
	return entries
		.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
		.map((entry) => entry.message.toolCallId);
}

function latestUnmatchedBatch(entries) {
	const results = new Set(resultCallIds(entries));
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message") continue;
		const calls = toolCalls(entry.message);
		if (calls.some((call) => !results.has(call.id))) return { entry, calls };
	}
	return undefined;
}

function latestCustom(entries, customType, requestId) {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== customType) continue;
		if (requestId === undefined || entry.data?.requestId === requestId || entry.data?.id === requestId) return entry;
	}
	return undefined;
}

function deferredMarker(entries, calls) {
	const callIds = new Set(calls.map((call) => call.id));
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== DEFERRED_ENTRY) continue;
		if (entry.ownerCallId && callIds.has(entry.ownerCallId)) return entry;
	}
	return undefined;
}

function compatibilityProblem(marker, registry) {
	for (const call of marker.calls ?? []) {
		const definition = registry[call.name];
		if (!definition) return { reason: "missing_tool", toolName: call.name };
	}

	const owner = (marker.calls ?? []).find((call) => call.id === marker.ownerCallId);
	const ownerDefinition = owner ? registry[owner.name] : undefined;
	if (!ownerDefinition?.deferral) return { reason: "missing_deferral_handler", toolName: owner?.name };
	if (ownerDefinition.deferral.protocolVersion !== marker.protocolVersion) {
		return { reason: "incompatible_protocol", toolName: owner.name };
	}
	if (
		ownerDefinition.deferral.handlerId !== marker.handlerId ||
		ownerDefinition.deferral.handlerVersion !== marker.handlerVersion
	) {
		return { reason: "incompatible_handler", toolName: owner.name };
	}
	return undefined;
}

export function classifyBranch(entries, registry) {
	const resultIds = resultCallIds(entries);
	const duplicateResultIds = [...new Set(resultIds.filter((callId, index) => resultIds.indexOf(callId) !== index))];
	if (duplicateResultIds.length > 0) return { state: "invalid_duplicate_results", callIds: duplicateResultIds };

	const batch = latestUnmatchedBatch(entries);
	if (!batch) return { state: "complete" };

	const owners = batch.calls.filter((call) => registry[call.name]?.deferral);
	const marker = deferredMarker(entries, batch.calls);
	if (!marker) {
		if (owners.length === 0) return { state: "ordinary_unmatched", callIds: batch.calls.map((call) => call.id) };
		if (owners.length > 1) return { state: "invalid_multiple_owners", callIds: owners.map((call) => call.id) };
		return {
			state: "markerless_recovery",
			ownerCallId: owners[0].id,
			heldCallIds: batch.calls.map((call) => call.id),
		};
	}

	const problem = compatibilityProblem(marker, registry);
	if (problem) return { state: "unavailable", ...problem };

	const request = latestCustom(entries, REQUEST_ENTRY, marker.requestId);
	const outcomes = entries.filter(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === OUTCOME_ENTRY &&
			entry.data?.requestId === marker.requestId,
	);
	if (outcomes.length > 1) return { state: "invalid_multiple_outcomes", count: outcomes.length };
	if (outcomes.length === 0) {
		return { state: "waiting", requestPresent: Boolean(request), requestId: marker.requestId };
	}

	const existingResults = new Set(resultCallIds(entries));
	const missingCallIds = (marker.calls ?? [])
		.map((call) => call.id)
		.filter((callId) => !existingResults.has(callId));
	if (missingCallIds.length === 0) return { state: "complete" };
	return {
		state: existingResults.has(marker.ownerCallId) ? "partial_resume" : "ready_to_resume",
		outcome: outcomes[0].data.outcome,
		missingCallIds,
	};
}

export function decideDeferral({ calls, registry, steering = [], followUp = [] }) {
	const owners = calls.filter((call) => registry[call.name]?.deferral);
	if (owners.length !== 1) {
		return { decision: owners.length === 0 ? "not_deferred" : "reject_multiple_owners" };
	}
	const queued = [...steering, ...followUp];
	if (queued.length > 0) {
		return {
			decision: "interrupt_before_waiting",
			ownerCallId: owners[0].id,
			provenance: "preexisting_user_input",
			drained: { steering: [...steering], followUp: [...followUp] },
		};
	}
	return {
		decision: "append_deferred_marker",
		ownerCallId: owners[0].id,
		heldCallIds: calls.map((call) => call.id),
	};
}
