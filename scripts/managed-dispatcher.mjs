#!/usr/bin/env node

import {
  defaultManagedDataRoot,
  disableManagedEntrypoint,
  dispatchActivePair,
  recoverPrevious,
} from "./lib/managed-runtime.mjs";

function recoveryMessage(error) {
  return [
    `pi: managed launch failed closed: ${error instanceof Error ? error.message : String(error)}`,
    "The selected Activation was not run and Stock Pi was not used.",
    "Recover explicitly: pi managed recover --previous",
    "Or disable managed ownership: pi managed disable",
  ].join("\n");
}

try {
  const args = process.argv.slice(2);
  const root = process.env.PI_MANAGED_DATA_ROOT || defaultManagedDataRoot();
  if (args.length === 3 && args[0] === "managed" && args[1] === "recover" && args[2] === "--previous") {
    const activation = recoverPrevious(root);
    console.log(`Recovered ${activation.active.managerReleaseId} + ${activation.active.downstreamReleaseId}.`);
  } else if (args.length === 2 && args[0] === "managed" && args[1] === "disable") {
    console.log(`Managed command ownership ${disableManagedEntrypoint(root)}.`);
  } else {
    process.exitCode = await dispatchActivePair(root, args);
  }
} catch (error) {
  console.error(recoveryMessage(error));
  process.exitCode = 1;
}
