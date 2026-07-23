#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyManagedUpdateArgs,
  legacyInstallationAdoptionMessages,
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
  readLegacyInstallationAdoption,
  recoverPrevious,
  verifyManagedInstallation,
} from "./lib/managed-runtime.mjs";
import {
  cachedManagedStartupNotice,
  formatManagedStatus,
  refreshManagedStartupStatus,
  runManagedUpdate,
} from "./lib/managed-update.mjs";

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
  return { activation, adoption: readLegacyInstallationAdoption(selectedDataRoot) };
}

function commandLocations(args) {
  const values = parseManagedOptions(args);
  rejectUnknownOptions(values, ["--data-root", "--bin-dir"]);
  return {
    dataRoot: values.get("--data-root") || dataRoot(),
    binDirectory: values.get("--bin-dir") || defaultManagedBinDirectory(),
  };
}

function installCompatibility(args) {
  const locations = commandLocations(args);
  const result = installManagedCompatibility(locations.dataRoot, {
    binDirectory: locations.binDirectory,
    checkpoint: interruptionCheckpoint(),
  });
  console.log(`Compatibility Entrypoint ${result}.`);
}

function enableOwnership(args) {
  const locations = commandLocations(args);
  const result = enableManagedOwnership(locations.dataRoot, {
    binDirectory: locations.binDirectory,
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

function piCommand(release, args, { loadQuestionTool = true } = {}) {
  const pi = join(release, "pi-wait-for-user", "pi-core");
  const questionTool = join(release, "pi-wait-for-user", "question-tool");
  return { pi, piArgs: loadQuestionTool ? [pi, "-e", questionTool, ...args] : [pi, ...args] };
}

function piEnvironment() {
  return { ...process.env, PI_SKIP_VERSION_CHECK: "1" };
}

function executePi(args) {
  const release = process.env.PI_MANAGED_RELEASE_DIR;
  if (!release) fail("Manager Release was not selected by the Managed Dispatcher");
  const leadingCommands = new Set(["install", "remove", "uninstall", "update", "list", "config", "conformance"]);
  const { pi, piArgs } = piCommand(release, args, { loadQuestionTool: !leadingCommands.has(args[0]) });
  const environment = piEnvironment();
  if (typeof process.execve === "function") process.execve(pi, piArgs, environment);
  const result = spawnSync(pi, piArgs.slice(1), { stdio: "inherit", env: environment });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

function packageUpdate(selected, options = []) {
  console.log("Package update phase (newly active Pi):");
  const { pi, piArgs } = piCommand(selected.releasePath, ["update", "--extensions", ...options], { loadQuestionTool: false });
  const result = spawnSync(pi, piArgs.slice(1), { stdio: "inherit", env: piEnvironment() });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function interactiveLaunch(args) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const nonInteractiveFlags = new Set([
    "-h", "--help", "-v", "--version", "-p", "--print", "--json", "--rpc", "--export", "--list-models",
  ]);
  if (args.some((argument) => nonInteractiveFlags.has(argument))) return false;
  if (["install", "remove", "uninstall", "list", "config", "conformance"].includes(args[0])) return false;
  const mode = args.indexOf("--mode");
  return mode < 0 || !["json", "rpc"].includes(args[mode + 1]);
}

function beginStartupCheck(args) {
  const environment = process.env;
  if (environment.PI_SKIP_VERSION_CHECK || environment.PI_OFFLINE || args.includes("--offline")) return;
  const manager = process.env.PI_MANAGED_MANAGER_DIR
    ? join(process.env.PI_MANAGED_MANAGER_DIR, "package", "manager")
    : process.execPath;
  const managerArgs = process.env.PI_MANAGED_MANAGER_DIR
    ? ["managed", "_startup-check"]
    : [fileURLToPath(import.meta.url), "managed", "_startup-check"];
  try {
    const child = spawn(manager, managerArgs, { detached: true, stdio: "ignore", env: environment });
    child.once("error", () => {});
    child.unref();
  } catch {
    // A background status refresh can never prevent normal Pi launch.
  }
}

function printManagedUpdate(result) {
  if (result.kind === "activated") {
    console.log(`Activated Downstream Release ${result.active.releaseId} (upstream Pi ${result.active.upstreamVersion}); Channel sequence ${result.channel.sequence}.`);
  } else if (result.kind === "patch-lag") {
    console.log(`Patch Lag: ${result.patchLag.currentReleaseId} is based on upstream Pi ${result.patchLag.currentUpstreamVersion}; observed upstream Pi ${result.patchLag.observedUpstreamVersion} is newer. The verified Activation remains active.`);
  } else if (result.kind === "incompatible") {
    console.log(`No compatible Downstream Release can be activated: ${result.incompatibility}. The current Activation remains active.`);
  } else {
    console.log(`Already current: ${result.active.releaseId} (upstream Pi ${result.active.upstreamVersion}); Channel sequence ${result.channel.sequence}.`);
    if (result.upstreamError) console.log(`Upstream Pi status unavailable (informational only): ${result.upstreamError}`);
  }
  if (result.fullyVerifiedCurrent) console.log(`Fully verified current Activation ${result.active.releaseId}.`);
}

async function update(args, route) {
  if (process.env.PI_OFFLINE) fail("Managed Update is unavailable while PI_OFFLINE is set");
  console.log("Managed Update phase:");
  const packageOptions = args.filter((argument) => ["--approve", "--no-approve", "-a", "-na"].includes(argument));
  const result = await runManagedUpdate(dataRoot(), {
    all: route.all,
    force: route.force,
    checkpoint: interruptionCheckpoint(),
    packagePhase: (selected) => packageUpdate(selected, packageOptions),
    managedPhaseComplete: printManagedUpdate,
  });
  if (route.all && result.partial) {
    const detail = result.packageError ? `: ${result.packageError}` : "";
    const managedOutcome = result.managed.kind === "activated"
      ? "Managed Update activated successfully"
      : `Managed Update completed as ${result.managed.kind} without activation`;
    console.error(`${managedOutcome}, but the package update phase failed with exit code ${result.packageExitCode}${detail}; the verified release remains active.`);
  }
  process.exitCode = result.exitCode;
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--manager-version") {
    console.log(packageIdentity());
  } else if (args[0] === "managed" && args[1] === "activate") {
    const { activation, adoption } = activate(args.slice(2));
    console.log(`Activated ${activation.active.managerReleaseId} + ${activation.active.downstreamReleaseId}.`);
    for (const message of legacyInstallationAdoptionMessages(adoption)) console.log(message);
  } else if (args[0] === "managed" && args[1] === "install-compatibility") {
    installCompatibility(args.slice(2));
  } else if (args[0] === "managed" && args[1] === "enable") {
    enableOwnership(args.slice(2));
  } else if (args[0] === "managed" && args[1] === "verify") {
    verifyInstallation(args.slice(2));
  } else if (args.length === 2 && args[0] === "managed" && args[1] === "status") {
    console.log(formatManagedStatus(dataRoot()));
  } else if (args.length === 2 && args[0] === "managed" && args[1] === "_startup-check") {
    try { await refreshManagedStartupStatus(dataRoot()); } catch { /* Startup refresh is silent and never delays launch. */ }
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
    const route = classifyManagedUpdateArgs(args);
    if (route.type === "reject") fail("Unknown update syntax; refusing to delegate a possible upstream-only Pi update path");
    if (route.type === "managed") await update(args.slice(1), route);
    else {
      if (args[0] !== "update") {
        try {
          const notice = cachedManagedStartupNotice(dataRoot(), {
            interactive: interactiveLaunch(args),
            offline: args.includes("--offline"),
          });
          if (notice) console.error(notice);
        } catch {
          // Malformed cached status is unsafe to render but cannot block normal launch.
        }
        try { beginStartupCheck(args); } catch {
          // An unavailable startup-check state cannot block normal launch.
        }
      }
      executePi(args);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`managed-manager: ${message}`);
  if (/Unknown .* schema version/i.test(message)) {
    console.error("The active pair remains selected. Review and rerun the current bootstrap to adopt a newer metadata schema.");
  }
  process.exitCode = 1;
}
