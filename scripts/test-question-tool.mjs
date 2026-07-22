#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const preparedNodeModules = join(projectRoot, ".work", "pi-v0.81.1", "node_modules");
const localNodeModules = join(projectRoot, "node_modules");
let linked = false;

try {
  if (!existsSync(preparedNodeModules)) {
    throw new Error("Prepare and build .work/pi-v0.81.1 before running the Question Tool suite");
  }
  if (!existsSync(localNodeModules)) {
    symlinkSync(preparedNodeModules, localNodeModules, process.platform === "win32" ? "junction" : "dir");
    linked = true;
  }
  const codingAgent = JSON.parse(
    readFileSync(join(localNodeModules, "@earendil-works", "pi-coding-agent", "package.json"), "utf8"),
  );
  if (codingAgent.version !== "0.81.1") {
    throw new Error(`Question Tool tests require Pi 0.81.1, found ${String(codingAgent.version)}`);
  }
  const tests = readdirSync(join(projectRoot, "packages", "question-tool", "test"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => `packages/question-tool/test/${name}`);
  const result = spawnSync(process.execPath, ["--test", ...tests], { cwd: projectRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`test-question-tool: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (linked) rmSync(localNodeModules);
}
