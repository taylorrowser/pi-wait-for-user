#!/usr/bin/env node

import { join, resolve } from "node:path";

import {
  legacyMigrationMessages,
  managedActivationOptions,
  parseManagedOptions,
  readPinnedRootKeys,
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
  readLegacyMigration,
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
  const rootKeys = readPinnedRootKeys(join(import.meta.dirname, "managed-root-keys.json"));
  const activation = installAndActivateFromPinnedRoot(managedActivationOptions(values, { dataRoot, rootKeys }));
  installManagedCompatibility(dataRoot, { binDirectory });
  if (managePi) enableManagedOwnership(dataRoot, { binDirectory });
  console.log(`${managePi ? "Managed" : "Side-by-side"} installation ready: ${activation.active.downstreamReleaseId}.`);
  if (managePi) console.log(shellHashRemediation);
  for (const message of legacyMigrationMessages(readLegacyMigration(dataRoot))) console.log(message);
} catch (error) {
  console.error(`managed-installer: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
