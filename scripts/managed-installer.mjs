#!/usr/bin/env node

import { resolve } from "node:path";

import {
  legacyMigrationMessages,
  nativeManagedPlatform,
  parseRootKeyOption,
  readJsonFile,
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
    "--root-key", "--manager-archive", "--release-archive", "--now",
  ]);
  for (const flag of values.keys()) if (!allowed.has(flag)) fail(`Unknown option: ${flag}`);
  return { values, managePi };
}

function usage() {
  return "Usage: managed-installer.mjs [--manage-pi] --trust PATH --channel PATH --manifest PATH --root-key KEY_ID=PUBLIC_KEY_PATH --manager-archive PATH --release-archive PATH [--data-root PATH] [--bin-dir PATH] [--platform PLATFORM] [--now ISO_DATE]";
}

function required(values, flag) {
  const value = values.get(flag);
  if (!value) fail(`Missing required option: ${flag}`);
  return value;
}

try {
  const { values, managePi } = parseArguments(process.argv.slice(2));
  const dataRoot = resolve(values.get("--data-root") || defaultManagedDataRoot());
  const binDirectory = resolve(values.get("--bin-dir") || defaultManagedBinDirectory());
  preflightManagedCommandOwnership(dataRoot, { binDirectory, managePi });
  const activation = installAndActivate({
    dataRoot,
    platform: values.get("--platform") || nativeManagedPlatform(),
    trustEnvelope: readJsonFile(required(values, "--trust")),
    channelEnvelope: readJsonFile(required(values, "--channel")),
    manifestEnvelope: readJsonFile(required(values, "--manifest")),
    rootKeys: new Map([parseRootKeyOption(required(values, "--root-key"))]),
    managerArchive: resolve(required(values, "--manager-archive")),
    releaseArchive: resolve(required(values, "--release-archive")),
    now: values.has("--now") ? new Date(values.get("--now")) : new Date(),
  });
  installManagedCompatibility(dataRoot, { binDirectory });
  if (managePi) enableManagedOwnership(dataRoot, { binDirectory });
  console.log(`${managePi ? "Managed" : "Side-by-side"} installation ready: ${activation.active.downstreamReleaseId}.`);
  for (const message of legacyMigrationMessages(readLegacyMigration(dataRoot))) console.log(message);
} catch (error) {
  console.error(`managed-installer: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
