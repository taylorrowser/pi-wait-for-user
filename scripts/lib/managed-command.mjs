import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const shellHashRemediation = "Run `hash -r`, then confirm this shell with: command -v pi";

export function parseManagedOptions(args, { booleanFlags = [] } = {}) {
  const values = new Map();
  while (args.length > 0) {
    const flag = args.shift();
    if (!flag?.startsWith("--") || values.has(flag)) throw new Error("Malformed managed command options");
    if (booleanFlags.includes(flag)) values.set(flag, true);
    else {
      const value = args.shift();
      if (!value) throw new Error(`Missing value for ${flag}`);
      values.set(flag, value);
    }
  }
  return values;
}

export function nativeManagedPlatform() {
  const os = process.platform === "darwin" ? "darwin" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch;
  const identity = `${os}-${arch}`;
  if (!/^(?:darwin|linux)-(?:arm64|x64)$/.test(identity)) throw new Error(`Unsupported managed platform: ${identity}`);
  return identity;
}

export function rejectUnknownOptions(values, allowed) {
  for (const flag of values.keys()) if (!allowed.includes(flag)) throw new Error(`Unknown option: ${flag}`);
}

export function readJsonFile(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

export function parseRootKeyOption(value) {
  const separator = value.indexOf("=");
  if (separator < 1 || separator === value.length - 1) throw new Error("--root-key must be KEY_ID=PUBLIC_KEY_PATH");
  return [value.slice(0, separator), readFileSync(resolve(value.slice(separator + 1)), "utf8")];
}

function required(values, flag) {
  const value = values.get(flag);
  if (!value) throw new Error(`Missing required option: ${flag}`);
  return value;
}

export function readPinnedRootKeys(path) {
  const document = readJsonFile(path);
  if (document?.schemaVersion !== 1 || !Array.isArray(document.rootKeys) || document.rootKeys.length === 0
    || Object.keys(document).sort().join(",") !== "rootKeys,schemaVersion") {
    throw new Error("Malformed pinned root-key configuration");
  }
  const keys = new Map();
  for (const entry of document.rootKeys) {
    if (!entry || Object.keys(entry).sort().join(",") !== "keyId,publicKey"
      || typeof entry.keyId !== "string" || !entry.keyId || typeof entry.publicKey !== "string" || !entry.publicKey
      || keys.has(entry.keyId)) throw new Error("Malformed pinned root-key configuration");
    keys.set(entry.keyId, entry.publicKey);
  }
  return keys;
}

export function managedActivationOptions(values, { dataRoot, now = new Date(), checkpoint } = {}) {
  const options = {
    dataRoot,
    platform: values.get("--platform") || nativeManagedPlatform(),
    trustEnvelope: readJsonFile(required(values, "--trust")),
    channelEnvelope: readJsonFile(required(values, "--channel")),
    manifestEnvelope: readJsonFile(required(values, "--manifest")),
    managerArchive: resolve(required(values, "--manager-archive")),
    releaseArchive: resolve(required(values, "--release-archive")),
    legacyDirectories: values.has("--legacy-dir") ? [resolve(values.get("--legacy-dir"))] : [],
    now,
    checkpoint,
  };
  if (values.has("--root-key")) options.rootKeys = new Map([parseRootKeyOption(values.get("--root-key"))]);
  return options;
}

export function legacyInstallationAdoptionMessages(adoption) {
  if (!adoption) return [];
  const result = adoption.disposition === "adopted-after-signed-verification"
    ? `Adopted verified Legacy Downstream Installation from ${adoption.legacyPath}.`
    : `Legacy Downstream Installation was not signed-payload identical and was left untouched at ${adoption.legacyPath}.`;
  return [result, adoption.cleanup];
}
