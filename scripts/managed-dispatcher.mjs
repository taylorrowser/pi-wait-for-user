#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultManagedDataRoot,
  disableManagedCommandOwnership,
  dispatchActivePair,
  recoverPrevious,
} from "./lib/managed-runtime.mjs";

function recoveryMessage(error) {
  return [
    `pi: managed launch failed closed: ${error instanceof Error ? error.message : String(error)}`,
    "The selected Activation was not run and Stock Pi was not used.",
    "Recover explicitly: pi managed recover --previous",
    "Or disable Command Ownership: pi managed disable",
  ].join("\n");
}

function selectedDataRoot() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  if (basename(scriptDirectory) === "dispatcher") {
    const receipt = JSON.parse(readFileSync(join(scriptDirectory, ".managed", "receipt.json"), "utf8"));
    if (receipt.type !== "managed-dispatcher" || realpathSync(resolve(receipt.ownedPath)) !== realpathSync(scriptDirectory)) {
      throw new Error("Managed Dispatcher cannot validate its data-root receipt");
    }
    return dirname(resolve(receipt.ownedPath));
  }
  return process.env.PI_MANAGED_DATA_ROOT || defaultManagedDataRoot();
}

try {
  const args = process.argv.slice(2);
  const root = selectedDataRoot();
  if (args.length === 3 && args[0] === "managed" && args[1] === "recover" && args[2] === "--previous") {
    const activation = recoverPrevious(root);
    console.log(`Recovered ${activation.active.managerReleaseId} + ${activation.active.downstreamReleaseId}.`);
  } else if (args.length === 2 && args[0] === "managed" && args[1] === "disable") {
    console.log(`Command Ownership ${disableManagedCommandOwnership(root)}.`);
  } else {
    process.exitCode = await dispatchActivePair(root, args);
  }
} catch (error) {
  console.error(recoveryMessage(error));
  process.exitCode = 1;
}
