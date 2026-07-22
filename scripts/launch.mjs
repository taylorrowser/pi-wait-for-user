#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  throw new Error(message);
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${String(expected)}, found ${String(actual)}`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

try {
  const separator = process.argv.indexOf("--", 2);
  if (separator < 3) fail("Usage: launch.mjs <install-directory> -- [pi arguments]");
  const installation = resolve(process.argv[2]);
  const piArguments = process.argv.slice(separator + 1);
  const source = join(installation, "pi");
  const questionRoot = join(installation, "question-tool");
  const receipt = readJson(join(installation, "receipt.json"));
  expectEqual(receipt.schemaVersion, 1, "Installation receipt schema");

  const repository = run("git", ["remote", "get-url", "origin"], source);
  expectEqual(repository, receipt.upstreamRepository, "Installed Pi repository");
  const tagCommit = run("git", ["rev-parse", `${receipt.upstreamTag}^{commit}`], source);
  expectEqual(tagCommit, receipt.upstreamCommit, "Installed Pi tag");
  const head = run("git", ["rev-parse", "HEAD"], source);
  expectEqual(head, receipt.upstreamCommit, "Installed Pi commit");
  const codingAgent = readJson(join(source, "packages", "coding-agent", "package.json"));
  expectEqual(codingAgent.name, "@earendil-works/pi-coding-agent", "Installed Pi package");
  expectEqual(codingAgent.version, receipt.upstreamPackageVersion, "Installed Pi version");

  const question = readJson(join(questionRoot, "package.json"));
  expectEqual(question.name, receipt.questionTool.name, "Question Tool package");
  expectEqual(question.version, receipt.questionTool.version, "Question Tool version");
  expectEqual(question.piWaitForUser?.upstreamPiVersion, receipt.upstreamPackageVersion, "Question Tool Pi version");
  expectEqual(
    JSON.stringify(question.piWaitForUser?.coreProtocolVersions),
    JSON.stringify(receipt.questionTool.coreProtocolVersions),
    "Question Tool protocol versions",
  );
  expectEqual(question.piWaitForUser?.handlerId, receipt.questionTool.handlerId, "Question Tool handler ID");
  expectEqual(question.piWaitForUser?.handlerVersion, receipt.questionTool.handlerVersion, "Question Tool handler version");

  const cli = join(source, "packages", "coding-agent", "dist", "cli.js");
  const childArguments = piArguments[0] === "conformance"
    ? [cli, ...piArguments]
    : [cli, "-e", questionRoot, ...piArguments];
  const child = spawnSync(process.execPath, childArguments, { stdio: "inherit" });
  if (child.error) throw child.error;
  if (child.signal) {
    process.kill(process.pid, child.signal);
  } else {
    process.exitCode = child.status ?? 1;
  }
} catch (error) {
  console.error(`pi-wait-for-user: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
