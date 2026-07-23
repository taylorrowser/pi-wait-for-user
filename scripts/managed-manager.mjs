#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanupManagedState,
  defaultManagedBinDirectory,
  defaultManagedDataRoot,
  disableManagedEntrypoint,
  enableManagedOwnership,
  executeStockPi,
  installAndActivate,
  installManagedCompatibility,
  readLegacyMigration,
  recoverPrevious,
  verifyManagedInstallation,
} from "./lib/managed-runtime.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function packageIdentity() {
  const manifest = readJson(join(projectRoot, "package.json"));
  const id = manifest.piWaitForUser?.managerReleaseId;
  if (typeof id !== "string") fail("Manager Release identity is missing from package metadata");
  return id;
}

function dataRoot() {
  return process.env.PI_MANAGED_DATA_ROOT || defaultManagedDataRoot();
}
function nativePlatform() {
  const os = process.platform === "darwin" ? "darwin" : process.platform;
  const architecture = process.arch === "x64" ? "x64" : process.arch;
  const platform = `${os}-${architecture}`;
  if (!/^(?:darwin|linux)-(?:arm64|x64)$/.test(platform)) fail(`Unsupported managed platform: ${platform}`);
  return platform;
}

function options(args, booleans = []) {
  const values = new Map();
  while (args.length > 0) {
    const flag = args.shift();
    if (!flag?.startsWith("--") || values.has(flag)) fail("Malformed managed command options");
    if (booleans.includes(flag)) values.set(flag, true);
    else {
      const value = args.shift();
      if (!value) fail(`Missing value for ${flag}`);
      values.set(flag, value);
    }
  }
  return values;
}

function required(values, flag) {
  const value = values.get(flag);
  if (!value) fail(`Missing required option: ${flag}`);
  return value;
}

function parseRootKey(value) {
  const separator = value.indexOf("=");
  if (separator < 1 || separator === value.length - 1) fail("--root-key must be KEY_ID=PUBLIC_KEY_PATH");
  return [value.slice(0, separator), readFileSync(resolve(value.slice(separator + 1)), "utf8")];
}

function activate(args) {
  const values = options(args);
  const allowed = new Set(["--data-root", "--platform", "--trust", "--channel", "--manifest", "--root-key", "--manager-archive", "--release-archive", "--now"]);
  for (const flag of values.keys()) if (!allowed.has(flag)) fail(`Unknown option: ${flag}`);
  const selectedDataRoot = values.get("--data-root") || dataRoot();
  const activation = installAndActivate({
    dataRoot: selectedDataRoot,
    platform: values.get("--platform") || nativePlatform(),
    trustEnvelope: readJson(required(values, "--trust")),
    channelEnvelope: readJson(required(values, "--channel")),
    manifestEnvelope: readJson(required(values, "--manifest")),
    rootKeys: new Map([parseRootKey(required(values, "--root-key"))]),
    managerArchive: resolve(required(values, "--manager-archive")),
    releaseArchive: resolve(required(values, "--release-archive")),
    now: values.has("--now") ? new Date(values.get("--now")) : new Date(),
    checkpoint: process.env.PI_MANAGED_INTERRUPT_AT
      ? (name) => { if (name === process.env.PI_MANAGED_INTERRUPT_AT) fail(`Interrupted at ${name}`); }
      : undefined,
  });
  return { activation, migration: readLegacyMigration(selectedDataRoot) };
}

function installCompatibility(args) {
  const values = options(args);
  for (const flag of values.keys()) if (!["--data-root", "--bin-dir"].includes(flag)) fail(`Unknown option: ${flag}`);
  const result = installManagedCompatibility(values.get("--data-root") || dataRoot(), {
    binDirectory: values.get("--bin-dir") || defaultManagedBinDirectory(),
  });
  console.log(`Managed compatibility command ${result}.`);
}

function enableOwnership(args) {
  const values = options(args);
  for (const flag of values.keys()) if (!["--data-root", "--bin-dir"].includes(flag)) fail(`Unknown option: ${flag}`);
  const result = enableManagedOwnership(values.get("--data-root") || dataRoot(), {
    binDirectory: values.get("--bin-dir") || defaultManagedBinDirectory(),
    checkpoint: process.env.PI_MANAGED_INTERRUPT_AT
      ? (name) => { if (name === process.env.PI_MANAGED_INTERRUPT_AT) fail(`Interrupted at ${name}`); }
      : undefined,
  });
  console.log(`Managed command ownership ${result}.`);
}

function verifyInstallation(args) {
  const values = options(args, ["--all", "--provenance"]);
  for (const flag of values.keys()) if (!["--all", "--provenance", "--data-root", "--gh"].includes(flag)) fail(`Unknown option: ${flag}`);
  const verified = verifyManagedInstallation(values.get("--data-root") || dataRoot(), {
    all: values.has("--all"),
    provenance: values.has("--provenance"),
    gh: values.get("--gh") || "gh",
  });
  console.log(`Verified ${verified.length} managed Activation pair${verified.length === 1 ? "" : "s"}.`);
}

function executePi(args) {
  const release = process.env.PI_MANAGED_RELEASE_DIR;
  if (!release) fail("Manager Release was not selected by the Managed Dispatcher");
  const pi = join(release, "pi-wait-for-user", "pi-core");
  const questionTool = join(release, "pi-wait-for-user", "question-tool");
  const piArgs = [pi, "-e", questionTool, ...args];
  if (typeof process.execve === "function") process.execve(pi, piArgs, process.env);
  const result = spawnSync(pi, piArgs.slice(1), { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--manager-version") {
    console.log(packageIdentity());
  } else if (args[0] === "managed" && args[1] === "activate") {
    const { activation, migration } = activate(args.slice(2));
    console.log(`Activated ${activation.active.managerReleaseId} + ${activation.active.downstreamReleaseId}.`);
    if (migration) {
      console.log(migration.disposition === "adopted-after-signed-verification"
        ? `Adopted verified legacy Downstream Release from ${migration.legacyPath}.`
        : `Legacy Downstream Release was not signed-payload identical and was left untouched at ${migration.legacyPath}.`);
      console.log(migration.cleanup);
    }
  } else if (args[0] === "managed" && args[1] === "install-compatibility") {
    installCompatibility(args.slice(2));
  } else if (args[0] === "managed" && args[1] === "enable") {
    enableOwnership(args.slice(2));
  } else if (args[0] === "managed" && args[1] === "verify") {
    verifyInstallation(args.slice(2));
  } else if (args.length === 3 && args[0] === "managed" && args[1] === "recover" && args[2] === "--previous") {
    const activation = recoverPrevious(dataRoot());
    console.log(`Recovered ${activation.active.managerReleaseId} + ${activation.active.downstreamReleaseId}.`);
  } else if (args.length === 2 && args[0] === "managed" && args[1] === "disable") {
    console.log(`Managed command ownership ${disableManagedEntrypoint(dataRoot())}.`);
  } else if (args.length === 2 && args[0] === "managed" && args[1] === "cleanup") {
    console.log(`Removed ${cleanupManagedState(dataRoot())} verified temporary path(s).`);
  } else if (args[0] === "managed" && args[1] === "stock" && args[2] === "--") {
    process.exitCode = executeStockPi(dataRoot(), args.slice(3));
  } else if (args[0] === "managed") {
    fail("Unknown managed command; refusing to delegate it to Pi");
  } else {
    executePi(args);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`managed-manager: ${message}`);
  if (/Unknown .* schema version/i.test(message)) {
    console.error("The active pair remains selected. Review and rerun the current bootstrap to adopt a newer metadata schema.");
  }
  process.exitCode = 1;
}
