import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function nativeManagedPlatform(platform = process.platform, architecture = process.arch) {
  const os = platform === "darwin" ? "darwin" : platform;
  const arch = architecture === "x64" ? "x64" : architecture;
  const identity = `${os}-${arch}`;
  if (!/^(?:darwin|linux)-(?:arm64|x64)$/.test(identity)) throw new Error(`Unsupported managed platform: ${identity}`);
  return identity;
}

export function readJsonFile(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

export function parseRootKeyOption(value) {
  const separator = value.indexOf("=");
  if (separator < 1 || separator === value.length - 1) throw new Error("--root-key must be KEY_ID=PUBLIC_KEY_PATH");
  return [value.slice(0, separator), readFileSync(resolve(value.slice(separator + 1)), "utf8")];
}

export function legacyMigrationMessages(migration) {
  if (!migration) return [];
  const result = migration.disposition === "adopted-after-signed-verification"
    ? `Adopted verified legacy Downstream Release from ${migration.legacyPath}.`
    : `Legacy Downstream Release was not signed-payload identical and was left untouched at ${migration.legacyPath}.`;
  return [result, migration.cleanup];
}
