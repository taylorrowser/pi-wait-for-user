/**
 * Throwaway experiment extension for durable-wait research.
 * Registers three probe tools and logs event ordering to EXP_LOG.
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";

const LOG = process.env.EXP_LOG ?? "/tmp/exp-ext-log.jsonl";
function log(ev: string, data?: Record<string, unknown>) {
	try {
		fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ev, ...data }) + "\n");
	} catch {
		// ignore
	}
}

export default function (pi: ExtensionAPI) {
	// --- Probe tool 1: hangs forever (long-running tool promise architecture) ---
	pi.registerTool({
		name: "ask_user",
		label: "Ask User (hanging)",
		description:
			"Ask the human user a question and wait for their answer. Use when instructed to ask the user something.",
		parameters: Type.Object({ question: Type.String({ description: "The question to ask" }) }),
		async execute(toolCallId, params, signal) {
			log("ask_user:execute:start", { toolCallId, params: params as unknown as Record<string, unknown> });
			return new Promise((resolve) => {
				signal?.addEventListener("abort", () => {
					log("ask_user:signal-aborted", { toolCallId });
					// Intentionally do NOT resolve: observe what pi does with an
					// aborted-but-unresolved execute() promise.
				});
			});
		},
	});

	// --- Probe tool 2: durable-yield style terminating result ---
	pi.registerTool({
		name: "yield_wait",
		label: "Yield Wait",
		description:
			"Ask the human user a question. The question is delivered out-of-band; the answer arrives later in a message tagged with the interaction request id. Use when instructed.",
		parameters: Type.Object({ question: Type.String({ description: "The question to ask" }) }),
		async execute(toolCallId, params) {
			log("yield_wait:execute", { toolCallId, params: params as unknown as Record<string, unknown> });
			return {
				content: [
					{
						type: "text" as const,
						text: `WAITING_FOR_USER interaction_request_id=REQ-7F3A. The user has been asked: "${(params as { question: string }).question}". Stop here; the answer will arrive later in a message referencing REQ-7F3A.`,
					},
				],
				details: { requestId: "REQ-7F3A" },
				terminate: true,
			};
		},
	});

	// --- Probe tool 3: plain non-terminating sibling ---
	pi.registerTool({
		name: "echo_note",
		label: "Echo Note",
		description: "Record a short note. Returns ok. Use when instructed.",
		parameters: Type.Object({ note: Type.String() }),
		async execute(toolCallId, params) {
			log("echo_note:execute", { toolCallId, params: params as unknown as Record<string, unknown> });
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	});

	// --- Event-order logging ---
	const events = [
		"input",
		"tool_call",
		"tool_execution_start",
		"tool_execution_end",
		"turn_start",
		"turn_end",
		"agent_start",
		"agent_end",
		"agent_settled",
		"message_start",
		"message_end",
		"session_start",
		"session_shutdown",
	] as const;
	for (const name of events) {
		try {
			// deno-lint-ignore no-explicit-any
			(pi as any).on(name, (event: any) => {
				const info: Record<string, unknown> = {};
				if (name === "input") {
					info.text = event?.text;
					info.source = event?.source;
					info.streamingBehavior = event?.streamingBehavior;
				}
				if (name === "message_start" || name === "message_end") info.role = event?.message?.role;
				if (name === "tool_execution_start" || name === "tool_execution_end") {
					info.toolName = event?.toolName;
					info.toolCallId = event?.toolCallId;
				}
				if (name === "session_start" || name === "session_shutdown") info.reason = event?.reason;
				if (name === "turn_end") info.toolResultCount = event?.toolResults?.length;
				log(`evt:${name}`, info);
			});
		} catch (e) {
			log("subscribe-failed", { name, error: String(e) });
		}
	}
}
