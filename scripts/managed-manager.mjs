#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  legacyMigrationMessages,
  managedActivationOptions,
  parseManagedOptions,
  readJsonFile,
  rejectUnknownOptions,
  shellHashRemediation,
} from "./lib/managed-command.mjs";
import {
  cleanupManagedState,
  defaultManagedBinDirectory,
  defaultManagedDataRoot,
  disableManagedCommandOwnership,
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

function packageIdentity() {
  const manifest = readJsonFile(join(projectRoot, "package.json"));
  const id = manifest.piWaitForUser?.managerReleaseId;
  if (typeof id !== "string") fail("Manager Release identity is missing from package metadata");
  return id;
}

function dataRoot() {
  return process.env.PI_MANAGED_DATA_ROOT || defaultManagedDataRoot();
}

function interruptionCheckpoint() {
  const interruptedAt = process.env.PI_MANAGED_INTERRUPT_AT;
  return interruptedAt
    ? (name) => { if (name === interruptedAt) fail(`Interrupted at ${name}`); }
    : undefined;
}

function activate(args) {
  const values = parseManagedOptions(args);
  rejectUnknownOptions(values, ["--data-root", "--platform", "--trust", "--channel", "--manifest", "--root-key", "--manager-archive", "--release-archive", "--legacy-dir", "--now"]);
  const selectedDataRoot = values.get("--data-root") || dataRoot();
  const activation = installAndActivate(managedActivationOptions(values, {
    dataRoot: selectedDataRoot,
    now: values.has("--now") ? new Date(values.get("--now")) : new Date(),
    checkpoint: interruptionCheckpoint(),
  }));
  return { activation, migration: readLegacyMigration(selectedDataRoot) };
}

function installCompatibility(args) {
  const values = parseManagedOptions(args);
  rejectUnknownOptions(values, ["--data-root", "--bin-dir"]);
  const result = installManagedCompatibility(values.get("--data-root") || dataRoot(), {
    binDirectory: values.get("--bin-dir") || defaultManagedBinDirectory(),
    checkpoint: interruptionCheckpoint(),
  });
  console.log(`Compatibility Entrypoint ${result}.`);
}

function enableOwnership(args) {
  const values = parseManagedOptions(args);
  rejectUnknownOptions(values, ["--data-root", "--bin-dir"]);
  const result = enableManagedOwnership(values.get("--data-root") || dataRoot(), {
    binDirectory: values.get("--bin-dir") || defaultManagedBinDirectory(),
    checkpoint: interruptionCheckpoint(),
  });
  console.log(`Command Ownership ${result}.`);
  console.log(shellHashRemediation);
}

function verifyInstallation(args) {
  const values = parseManagedOptions(args, { booleanFlags: ["--all", "--provenance"] });
  rejectUnknownOptions(values, ["--all", "--provenance", "--data-root", "--gh"]);
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
    for (const message of legacyMigrationMessages(migration)) console.log(message);
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
    console.log(`Command Ownership ${disableManagedCommandOwnership(dataRoot())}.`);
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
