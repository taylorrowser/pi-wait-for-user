#!/usr/bin/env node
/**
 * RPC driver for durable-wait experiments against `pi --mode rpc`.
 * Usage: node driver.mjs <scenario> [--continue]
 * Logs all pi stdout/stderr lines (timestamped) to logs/<scenario>-rpc.jsonl
 * and snapshots session JSONL files at key points.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scenario = process.argv[2];
const useContinue = process.argv.includes("--continue");
const SESSION_DIR = path.join(
  HERE,
  "sessions",
  scenario === "s4-continue" ? "s3-terminate" : scenario.replace(/-resume$/, ""),
);
const LOGS = path.join(HERE, "logs");
fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });
const rpcLog = path.join(LOGS, `${scenario}${useContinue ? "-resume" : ""}-rpc.jsonl`);
fs.writeFileSync(rpcLog, "");

function note(kind, data) {
  const line = JSON.stringify({ t: new Date().toISOString(), kind, ...data });
  fs.appendFileSync(rpcLog, line + "\n");
  console.log(line);
}

const args = [
  "--mode", "rpc",
  "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
  "--extension", path.join(HERE, "ext.ts"),
  "--session-dir", SESSION_DIR,
  "--thinking", "low",
];
if (useContinue) args.push("--continue");

const child = spawn("pi", args, {
  cwd: HERE,
  env: { ...process.env, EXP_LOG: path.join(LOGS, `${scenario}${useContinue ? "-resume" : ""}-ext.jsonl`) },
  stdio: ["pipe", "pipe", "pipe"],
});
note("spawn", { pid: child.pid, args });

const seen = []; // parsed stdout objects
let stdoutBuf = "";
child.stdout.on("data", (d) => {
  stdoutBuf += d.toString();
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx);
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      seen.push(obj);
      note("pi", { msg: obj });
    } catch {
      note("pi-raw", { line });
    }
  }
});
child.stderr.on("data", (d) => note("pi-stderr", { line: d.toString() }));
child.on("exit", (code, sig) => note("pi-exit", { code, sig }));

function send(obj) {
  note("send", { msg: obj });
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred, label, timeoutMs = 120000) {
  const start = Date.now();
  let cursor = 0;
  while (Date.now() - start < timeoutMs) {
    while (cursor < seen.length) {
      const obj = seen[cursor++];
      if (pred(obj)) {
        note("waitFor-hit", { label });
        return obj;
      }
    }
    await sleep(100);
  }
  note("waitFor-timeout", { label });
  return null;
}

function snapshotSessions(tag) {
  const files = fs.existsSync(SESSION_DIR)
    ? fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".jsonl"))
    : [];
  for (const f of files) {
    const src = path.join(SESSION_DIR, f);
    const dst = path.join(LOGS, `${scenario}${useContinue ? "-resume" : ""}-${tag}-${f}`);
    fs.copyFileSync(src, dst);
    note("snapshot", { tag, file: f, dst, bytes: fs.statSync(src).size });
  }
}

const isEvt = (o, t) => o?.type === t || (o?.type === "event" && o?.event?.type === t);
const evtOf = (o) => (o?.type === "event" ? o.event : o);

async function main() {
  await sleep(3000); // let startup finish

  if (scenario === "s1-hang") {
    send({ type: "prompt", message: "Call the ask_user tool now with the question 'What is your favorite color?'. Do not answer yourself; just call the tool." });
    const hit = await waitFor((o) => isEvt(o, "tool_execution_start"), "tool_execution_start");
    if (!hit) throw new Error("tool never started");
    await sleep(2000);
    send({ type: "get_state" });
    await waitFor((o) => JSON.stringify(o).includes("isStreaming"), "get_state-response", 10000);
    snapshotSessions("during-hang");
    // Ordinary user message while the tool hangs
    send({ type: "prompt", message: "hello, just an ordinary user message", streamingBehavior: "steer" });
    await sleep(2500);
    snapshotSessions("after-steer");
    note("killing", { how: "SIGKILL" });
    child.kill("SIGKILL");
    await sleep(1000);
    snapshotSessions("after-kill");
    process.exit(0);
  }

  if (scenario === "s1-hang-resume") {
    // spawned with --continue on s1-hang's session dir
    send({ type: "get_state" });
    await waitFor((o) => JSON.stringify(o).includes("isStreaming"), "get_state-response", 10000);
    send({ type: "prompt", message: "What were you doing before the restart? Please continue." });
    await waitFor((o) => isEvt(o, "agent_settled") || isEvt(o, "extension_error") || JSON.stringify(o).toLowerCase().includes("error"), "settled-or-error", 180000);
    await sleep(2000);
    send({ type: "get_last_assistant_text" });
    await sleep(2000);
    snapshotSessions("after-resume");
    child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 1500);
    return;
  }

  if (scenario === "s3-terminate") {
    send({ type: "prompt", message: "Call the yield_wait tool now with the question 'Pick a fruit'. Do not do anything else." });
    await waitFor((o) => isEvt(o, "agent_settled"), "agent_settled", 180000);
    snapshotSessions("after-yield");
    // s4: later response correlated to the request id
    send({ type: "prompt", message: "Interaction request REQ-7F3A has been resolved. The user's response: 'mango'. Continue accordingly." });
    await waitFor((o) => isEvt(o, "agent_settled"), "agent_settled-2", 180000);
    send({ type: "get_last_assistant_text" });
    await sleep(2000);
    snapshotSessions("after-continuation");
    child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 1500);
    return;
  }

  if (scenario === "s4-continue") {
    // spawned with --continue on s3-terminate's session (ends with yield_wait toolResult)
    send({ type: "prompt", message: "Interaction request REQ-7F3A has been resolved. The user's response: 'mango'. Continue accordingly." });
    await waitFor((o) => isEvt(o, "message_end") && evtOf(o)?.message?.role === "assistant" && JSON.stringify(evtOf(o).message.content).includes("text"), "assistant-reply", 180000);
    await sleep(1500);
    send({ type: "get_last_assistant_text" });
    await sleep(2000);
    snapshotSessions("after-continuation");
    child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 1500);
    return;
  }

  if (scenario === "s3b-batch") {
    send({ type: "prompt", message: "In one single assistant message, make TWO parallel tool calls: yield_wait with question 'Pick a fruit' AND echo_note with note 'sibling'. Both calls must be in the same message." });
    await waitFor((o) => isEvt(o, "agent_settled"), "agent_settled", 240000);
    await sleep(1000);
    snapshotSessions("after-batch");
    child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 1500);
    return;
  }

  if (scenario === "s5-abort") {
    send({ type: "prompt", message: "Call the ask_user tool now with the question 'What is your favorite color?'. Do not answer yourself; just call the tool." });
    const hit = await waitFor((o) => isEvt(o, "tool_execution_start"), "tool_execution_start");
    if (!hit) throw new Error("tool never started");
    await sleep(1500);
    send({ type: "abort" });
    await waitFor((o) => isEvt(o, "agent_settled"), "agent_settled-after-abort", 30000);
    await sleep(1500);
    snapshotSessions("after-abort");
    child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 1500);
    return;
  }

  throw new Error(`unknown scenario ${scenario}`);
}

main().catch((e) => {
  note("driver-error", { error: String(e) });
  child.kill("SIGKILL");
  process.exit(1);
});
