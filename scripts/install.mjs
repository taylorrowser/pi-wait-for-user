#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const active = readJson(join(projectRoot, "releases", "active.json"));
const releaseDirectory = join(projectRoot, "releases", active.releaseId);
const manifest = readJson(join(releaseDirectory, "manifest.json"));

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd, options = {}) {
  if (!options.quiet) console.log(`> ${basename(command)} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.quiet ? [result.stdout, result.stderr].filter(Boolean).join("\n").trim() : "";
    fail(`${basename(command)} exited with status ${String(result.status)}${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout?.trim() ?? "";
}

function defaultDataRoot() {
  if (process.platform === "win32") return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

function defaultBinDirectory() {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? homedir(), "pi-wait-for-user", "bin");
  return join(homedir(), ".local", "bin");
}

function parseOptions(args) {
  const command = args.shift();
  if (!["install", "activate", "uninstall", "verify"].includes(command)) fail(usage());
  const options = {
    command,
    installDirectory: join(defaultDataRoot(), "pi-wait-for-user", "releases", manifest.releaseId),
    binDirectory: defaultBinDirectory(),
    source: undefined,
  };
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (!value) fail(usage());
    if (flag === "--install-dir") options.installDirectory = resolve(value);
    else if (flag === "--bin-dir") options.binDirectory = resolve(value);
    else if (flag === "--source" && command === "install") options.source = resolve(value);
    else fail(usage());
  }
  return options;
}

function usage() {
  return "Usage: install.mjs <install|activate|uninstall|verify> [--install-dir <path>] [--bin-dir <path>] [--source <exact-pi-checkout>]";
}

function passingReport() {
  const path = join(releaseDirectory, "reports", "release-candidate.json");
  if (!existsSync(path)) fail(`Release has no passing release-candidate report: ${path}`);
  const report = readJson(path);
  const gate = readJson(join(releaseDirectory, "fixture-gate.json"));
  const stageNames = (report.stages ?? []).map((stage) => stage.name);
  const conformance = report.stages?.find((stage) => stage.name === "public-conformance")?.result;
  if (
    report.releaseId !== manifest.releaseId ||
    report.result !== "passed" ||
    JSON.stringify(report.upstream) !== JSON.stringify(manifest.upstream) ||
    JSON.stringify(stageNames) !== JSON.stringify(gate.requiredStages) ||
    report.stages.some((stage) => stage.status !== "passed") ||
    !conformance ||
    conformance.passed !== conformance.required ||
    conformance.required < 1
  ) {
    fail(`Release has no passing release-candidate report for ${manifest.releaseId}`);
  }
  return { path, report };
}

function receipt(report) {
  return {
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    upstreamRepository: manifest.upstream.repository,
    upstreamTag: manifest.upstream.tag,
    upstreamCommit: manifest.upstream.commit,
    upstreamPackageVersion: manifest.upstream.packageVersion,
    questionTool: {
      name: manifest.questionTool.name,
      version: manifest.questionTool.version,
      coreProtocolVersions: manifest.questionTool.coreProtocolVersions,
      handlerId: manifest.questionTool.handlerId,
      handlerVersion: manifest.questionTool.handlerVersion,
    },
    releaseGate: {
      finishedAt: report.finishedAt,
      stages: report.stages.length,
    },
  };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function launcherPaths(binDirectory) {
  return process.platform === "win32"
    ? [join(binDirectory, "pi-wait-for-user.cmd")]
    : [join(binDirectory, "pi-wait-for-user")];
}

function writeLauncher(binDirectory, installation) {
  mkdirSync(binDirectory, { recursive: true });
  const launchScript = join(installation, "launch.mjs");
  const path = join(binDirectory, process.platform === "win32" ? "pi-wait-for-user.cmd" : "pi-wait-for-user");
  const temporary = join(binDirectory, `.${basename(path)}.tmp-${randomUUID()}`);
  try {
    if (process.platform === "win32") {
      writeFileSync(temporary, `@echo off\r\n"${process.execPath}" "${launchScript}" "${installation}" -- %*\r\n`);
    } else {
      writeFileSync(
        temporary,
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(launchScript)} ${shellQuote(installation)} -- "$@"\n`,
      );
      chmodSync(temporary, 0o755);
    }
    renameSync(temporary, path);
    return path;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function install(options) {
  const { path: reportPath, report } = passingReport();
  run(process.execPath, [join(projectRoot, "scripts", "release.mjs"), "verify"], projectRoot, { quiet: true });
  if (existsSync(options.installDirectory)) {
    fail(`Install directory already exists: ${options.installDirectory}\nRun uninstall first or choose --install-dir.`);
  }

  const parent = dirname(options.installDirectory);
  mkdirSync(parent, { recursive: true });
  const temporary = join(parent, `.${basename(options.installDirectory)}.tmp-${randomUUID()}`);
  const source = join(temporary, "pi");
  let installed = false;
  try {
    mkdirSync(temporary, { recursive: true });
    if (options.source) {
      cpSync(options.source, source, { recursive: true });
      run(process.execPath, [join(projectRoot, "scripts", "pi-patch.mjs"), "apply", source], projectRoot);
    } else {
      run(process.execPath, [join(projectRoot, "scripts", "pi-patch.mjs"), "prepare", source], projectRoot);
    }

    run("npm", ["ci", "--ignore-scripts"], source);
    run("npm", ["run", "hydrate:model-data"], source);
    run("npm", ["run", "build:offline"], source);
    const cli = join(source, "packages", "coding-agent", "dist", "cli.js");
    run(process.execPath, [cli, "conformance"], projectRoot);

    cpSync(join(projectRoot, "packages", "question-tool"), join(temporary, "question-tool"), {
      recursive: true,
      filter: (path) => !path.includes(`${join("question-tool", "test")}`),
    });
    cpSync(join(projectRoot, "scripts", "launch.mjs"), join(temporary, "launch.mjs"));
    cpSync(join(releaseDirectory, "manifest.json"), join(temporary, "release-manifest.json"));
    cpSync(reportPath, join(temporary, "release-candidate.json"));
    writeFileSync(join(temporary, "receipt.json"), `${JSON.stringify(receipt(report), null, 2)}\n`);

    const smokeHome = join(temporary, "smoke-home");
    mkdirSync(smokeHome);
    run(
      process.execPath,
      [join(temporary, "launch.mjs"), temporary, "--", "--list-models"],
      projectRoot,
      {
        quiet: true,
        env: { ...process.env, HOME: smokeHome, USERPROFILE: smokeHome, PI_CODING_AGENT_DIR: join(smokeHome, ".pi", "agent") },
      },
    );
    rmSync(smokeHome, { recursive: true, force: true });

    renameSync(temporary, options.installDirectory);
    installed = true;
    const launcher = writeLauncher(options.binDirectory, options.installDirectory);
    console.log(`\nInstalled ${manifest.releaseId}.`);
    console.log(`Command: ${launcher}`);
    if (!launcherPaths(options.binDirectory).some((path) => (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").includes(dirname(path)))) {
      console.log(`Add ${options.binDirectory} to PATH, then run: pi-wait-for-user`);
    } else {
      console.log("Run: pi-wait-for-user");
    }
    console.log("Your existing pi installation and ~/.pi data were not modified.");
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    if (installed) rmSync(options.installDirectory, { recursive: true, force: true });
    throw error;
  }
}

function uninstall(options) {
  if (!existsSync(options.installDirectory)) fail(`No installation found at ${options.installDirectory}`);
  const installed = readJson(join(options.installDirectory, "receipt.json"));
  if (installed.releaseId !== manifest.releaseId) fail(`Refusing to remove an installation owned by ${String(installed.releaseId)}`);
  for (const launcher of launcherPaths(options.binDirectory)) {
    if (!existsSync(launcher)) continue;
    const contents = readFileSync(launcher, "utf8");
    if (contents.includes(options.installDirectory)) rmSync(launcher);
  }
  rmSync(options.installDirectory, { recursive: true, force: true });
  console.log(`Removed ${manifest.releaseId}. Pi settings and sessions were left unchanged.`);
}

function verify(options) {
  if (!existsSync(options.installDirectory)) fail(`No installation found at ${options.installDirectory}`);
  run(
    process.execPath,
    [join(options.installDirectory, "launch.mjs"), options.installDirectory, "--", "--version"],
    projectRoot,
  );
  console.log(`Verified installed release ${manifest.releaseId}.`);
}

function activate(options) {
  verify(options);
  const launcher = writeLauncher(options.binDirectory, options.installDirectory);
  console.log(`Activated ${manifest.releaseId}: ${launcher}`);
}

try {
  const options = parseOptions(process.argv.slice(2));
  if (options.command === "install") install(options);
  else if (options.command === "activate") activate(options);
  else if (options.command === "uninstall") uninstall(options);
  else verify(options);
} catch (error) {
  console.error(`install: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
