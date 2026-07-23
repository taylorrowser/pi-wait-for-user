#!/usr/bin/env node

import { resolve } from "node:path";

import {
  legacyMigrationMessages,
  managedActivationOptions,
  shellHashRemediation,
} from "./lib/managed-command.mjs";
import {
  defaultManagedBinDirectory,
  defaultManagedDataRoot,
  enableManagedOwnership,
  installAndActivate,
  installManagedCompatibility,
  preflightManagedCommandOwnership,
  readLegacyMigration,
} from "./lib/managed-runtime.mjs";

function fail(message) {
  throw new Error(message);
}

function parseArguments(args) {
  const values = new Map();
  let managePi = false;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--manage-pi") {
      if (managePi) fail("Duplicate option: --manage-pi");
      managePi = true;
      continue;
    }
    if (!flag?.startsWith("--") || values.has(flag)) fail(usage());
    const value = args.shift();
    if (!value) fail(`Missing value for ${flag}`);
    values.set(flag, value);
  }
  const allowed = new Set([
    "--data-root", "--bin-dir", "--platform", "--trust", "--channel", "--manifest",
    "--root-key", "--manager-archive", "--release-archive",
  ]);
  for (const flag of values.keys()) if (!allowed.has(flag)) fail(`Unknown option: ${flag}`);
  return { values, managePi };
}

function usage() {
  return "Usage: managed-installer.mjs [--manage-pi] --trust PATH --channel PATH --manifest PATH --root-key KEY_ID=PUBLIC_KEY_PATH --manager-archive PATH --release-archive PATH [--data-root PATH] [--bin-dir PATH] [--platform PLATFORM]";
}

try {
  const { values, managePi } = parseArguments(process.argv.slice(2));
  const dataRoot = resolve(values.get("--data-root") || defaultManagedDataRoot());
  const binDirectory = resolve(values.get("--bin-dir") || defaultManagedBinDirectory());
  preflightManagedCommandOwnership(dataRoot, { binDirectory, managePi });
  const activation = installAndActivate(managedActivationOptions(values, { dataRoot }));
  installManagedCompatibility(dataRoot, { binDirectory });
  if (managePi) enableManagedOwnership(dataRoot, { binDirectory });
  console.log(`${managePi ? "Managed" : "Side-by-side"} installation ready: ${activation.active.downstreamReleaseId}.`);
  if (managePi) console.log(shellHashRemediation);
  for (const message of legacyMigrationMessages(readLegacyMigration(dataRoot))) console.log(message);
} catch (error) {
  console.error(`managed-installer: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
