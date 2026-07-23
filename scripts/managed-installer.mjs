#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  legacyInstallationAdoptionMessages,
  managedActivationOptions,
  parseManagedOptions,
  rejectUnknownOptions,
  shellHashRemediation,
} from "./lib/managed-command.mjs";
import {
  defaultManagedBinDirectory,
  defaultManagedDataRoot,
  enableManagedOwnership,
  installAndActivateFromPinnedRoot,
  installManagedCompatibility,
  preflightManagedCommandOwnership,
  readActivation,
  readLegacyInstallationAdoption,
  recoverPrevious,
} from "./lib/managed-runtime.mjs";

function parseArguments(args) {
  const values = parseManagedOptions(args, { booleanFlags: ["--manage-pi"] });
  rejectUnknownOptions(values, [
    "--manage-pi", "--data-root", "--bin-dir", "--platform", "--trust", "--channel", "--manifest",
    "--manager-archive", "--release-archive", "--legacy-dir",
  ]);
  return { values, managePi: values.has("--manage-pi") };
}

function usage() {
  return "Usage: managed-installer.mjs [--manage-pi] --trust PATH --channel PATH --manifest PATH --manager-archive PATH --release-archive PATH [--data-root PATH] [--bin-dir PATH] [--legacy-dir PATH] [--platform PLATFORM]";
}

try {
  const { values, managePi } = parseArguments(process.argv.slice(2));
  const dataRoot = resolve(values.get("--data-root") || defaultManagedDataRoot());
  const binDirectory = resolve(values.get("--bin-dir") || defaultManagedBinDirectory());
  preflightManagedCommandOwnership(dataRoot, { binDirectory, managePi });
  const activationPath = join(dataRoot, "state", "activation.json");
  const priorActivation = existsSync(activationPath) ? readActivation(dataRoot) : undefined;
  const activation = installAndActivateFromPinnedRoot(managedActivationOptions(values, { dataRoot }));
  const switched = priorActivation
    && JSON.stringify(priorActivation.active) !== JSON.stringify(activation.active);
  try {
    installManagedCompatibility(dataRoot, { binDirectory });
    if (managePi) enableManagedOwnership(dataRoot, { binDirectory });
  } catch (error) {
    if (switched) recoverPrevious(dataRoot);
    throw error;
  }
  console.log(`${managePi ? "Managed" : "Side-by-side"} installation ready: ${activation.active.downstreamReleaseId}.`);
  if (managePi) console.log(shellHashRemediation);
  for (const message of legacyInstallationAdoptionMessages(readLegacyInstallationAdoption(dataRoot))) console.log(message);
} catch (error) {
  console.error(`managed-installer: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
