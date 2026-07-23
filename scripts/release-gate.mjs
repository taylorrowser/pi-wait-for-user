#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadReleaseInput } from "./lib/release-input.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { releaseId, manifest } = loadReleaseInput(projectRoot);
const releaseDirectory = join(projectRoot, "releases", releaseId);
const gate = JSON.parse(readFileSync(join(releaseDirectory, "fixture-gate.json"), "utf8"));
const workspace = join(projectRoot, ".work", `pi-v${manifest.upstream.packageVersion}`);

function fail(message) {
  throw new Error(message);
}

function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(temporary, path);
}

function commandStage(name, command, args, cwd, environment) {
  return { name, command, args, cwd, environment };
}

function portable(value) {
  if (value === process.execPath) return "node";
  if (value === projectRoot) return ".";
  if (value.startsWith(`${projectRoot}/`)) return value.slice(projectRoot.length + 1);
  return value;
}

function releaseStages(environment) {
  const cli = join(workspace, "packages", "coding-agent", "dist", "cli.js");
  return [
    commandStage("release-inputs", process.execPath, [join(projectRoot, "scripts", "release.mjs"), "verify"], projectRoot, environment),
    commandStage("repository-tests", "npm", ["test"], projectRoot, environment),
    commandStage("prepare-exact-patch", process.execPath, [join(projectRoot, "scripts", "pi-patch.mjs"), "prepare", workspace], projectRoot, environment),
    commandStage("install-dependencies", "npm", ["ci", "--ignore-scripts"], workspace, environment),
    commandStage("typecheck", "npm", ["run", "check"], workspace, environment),
    commandStage("hydrate-model-data", "npm", ["run", "hydrate:model-data"], workspace, environment),
    commandStage("build", "npm", ["run", "build:offline"], workspace, environment),
    commandStage(
      "legacy-compatibility",
      join(projectRoot, "prototype", "session-journal-harness", "run.sh"),
      [join(workspace, "packages", "coding-agent")],
      projectRoot,
      environment,
    ),
    commandStage("full-pi-suite", join(workspace, "test.sh"), [], workspace, environment),
    commandStage("public-conformance", process.execPath, [cli, "conformance"], projectRoot, environment),
    commandStage("question-tool-typecheck", "npm", ["run", "typecheck:question-tool"], projectRoot, environment),
    commandStage("question-tool-suite", "npm", ["run", "test:question-tool"], projectRoot, environment),
  ];
}

function verifyFixtureGate() {
  if (
    gate.schemaVersion !== 1 ||
    !Array.isArray(gate.requiredStages) ||
    gate.requiredStages.length === 0 ||
    !Array.isArray(gate.categories) ||
    gate.categories.length === 0
  ) {
    fail("Invalid fixture gate");
  }
  for (const category of gate.categories) {
    if (typeof category.name !== "string" || !Array.isArray(category.fixtures) || category.fixtures.length === 0) {
      fail("Each fixture category must have a name and at least one fixture");
    }
  }
}

function verifyFixtureInventory() {
  verifyFixtureGate();
  for (const category of gate.categories) {
    for (const fixture of category.fixtures) {
      const root = fixture.startsWith("packages/question-tool/") || fixture.startsWith("prototype/")
        ? projectRoot
        : workspace;
      if (!existsSync(join(root, fixture))) fail(`Missing ${category.name} fixture: ${fixture}`);
    }
  }
}

function parseArguments(args) {
  if (args.length === 1 && args[0] === "--list") return { list: true };
  let report = join(releaseDirectory, "reports", "release-candidate.json");
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--report" && args[index + 1]) {
      report = resolve(args[index + 1]);
      index += 1;
    } else {
      fail("Usage: release-gate.mjs [--list | --report <path>]");
    }
  }
  return { list: false, report };
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.list) {
    verifyFixtureGate();
    for (const category of gate.categories) console.log(category.name);
  } else {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19)) fail("Release verification requires Node.js 22.19 or newer");
    if (existsSync(workspace)) fail(`Release workspace already exists; remove it before a clean gate: ${workspace}`);

    const verificationHome = join(projectRoot, ".work", "release-home");
    rmSync(verificationHome, { recursive: true, force: true });
    mkdirSync(verificationHome, { recursive: true });
    const environment = {
      ...process.env,
      HOME: verificationHome,
      USERPROFILE: verificationHome,
      PI_CODING_AGENT_DIR: join(verificationHome, ".pi", "agent"),
      PI_HARNESS_REPORT_DIR: join(releaseDirectory, "reports", "legacy"),
      PI_HARNESS_REPORT_NAME: "pi-0.81.1-patched.json",
    };
    const stages = releaseStages(environment);
    const stageNames = stages.map((stage) => stage.name);
    if (JSON.stringify(stageNames) !== JSON.stringify(gate.requiredStages)) {
      fail("Release commands do not match the pinned required stages");
    }
    const report = {
      schemaVersion: 1,
      releaseId: manifest.releaseId,
      upstream: manifest.upstream,
      startedAt: new Date().toISOString(),
      result: "running",
      fixtureCategories: gate.categories,
      stages: [],
    };
    writeReport(options.report, report);

    for (const stage of stages) {
      console.log(`\n=== ${stage.name} ===`);
      const started = Date.now();
      const capture = stage.name === "public-conformance";
      const result = spawnSync(stage.command, stage.args, {
        cwd: stage.cwd,
        env: stage.environment,
        encoding: capture ? "utf8" : undefined,
        stdio: capture ? "pipe" : "inherit",
      });
      if (capture) {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      }
      let conformanceFailure;
      const stageResult = {
        name: stage.name,
        command: [stage.command, ...stage.args].map(portable),
        status: result.status === 0 ? "passed" : "failed",
        durationMs: Date.now() - started,
      };
      if (capture && result.status === 0) {
        const match = result.stdout.match(/Deferred conformance passed \((\d+)\/(\d+)\)/);
        if (match) stageResult.result = { passed: Number(match[1]), required: Number(match[2]) };
        else {
          stageResult.status = "failed";
          conformanceFailure = "Public conformance did not report its required result";
        }
      }
      report.stages.push(stageResult);
      if (result.error || result.status !== 0 || conformanceFailure) {
        report.result = "failed";
        report.finishedAt = new Date().toISOString();
        report.failure = conformanceFailure ?? result.error?.message ?? `${stage.name} exited with status ${String(result.status)}`;
        writeReport(options.report, report);
        fail(report.failure);
      }
      if (stage.name === "prepare-exact-patch") verifyFixtureInventory();
      writeReport(options.report, report);
    }

    report.result = "passed";
    report.finishedAt = new Date().toISOString();
    writeReport(options.report, report);
    console.log(`\nRelease candidate ${manifest.releaseId} passed ${report.stages.length}/${report.stages.length} required stages.`);
    console.log(`Report: ${options.report}`);
  }
} catch (error) {
  console.error(`release-gate: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
