#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with status ${String(result.status)}`);
}

try {
  const [sourceArgument] = process.argv.slice(2);
  if (!sourceArgument || process.argv.length !== 3) {
    throw new Error("Usage: verify-upstream.mjs <unmodified-pi-source>");
  }
  const source = resolve(sourceArgument);
  const patchCommand = join(projectRoot, "scripts", "pi-patch.mjs");

  run(process.execPath, [patchCommand, "verify", source], projectRoot);

  const verificationHome = mkdtempSync(join(tmpdir(), "pi-upstream-verification-"));
  const environment = {
    ...process.env,
    HOME: verificationHome,
    PI_CODING_AGENT_DIR: join(verificationHome, ".pi", "agent"),
  };
  try {
    run("npm", ["ci", "--ignore-scripts"], source, environment);
    run("npm", ["run", "check"], source, environment);
    run("npm", ["run", "hydrate:model-data"], source, environment);
    run("npm", ["run", "build:offline"], source, environment);
    run(join(source, "test.sh"), [], source, environment);
    run(
      join(projectRoot, "prototype", "session-journal-harness", "run.sh"),
      [join(source, "packages", "coding-agent")],
      projectRoot,
      environment,
    );
    run(process.execPath, [patchCommand, "verify", source], projectRoot, environment);
    console.log("Pinned upstream build, checks, tests, and session-journal harness passed.");
  } finally {
    rmSync(verificationHome, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`verify-upstream: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
