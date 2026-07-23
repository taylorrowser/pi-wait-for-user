import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function releaseIdFromPackage(root) {
  const packageManifest = readJson(join(root, "package.json"));
  if (typeof packageManifest.version !== "string" || !/^\d+\.\d+\.\d+-patch\.\d+$/.test(packageManifest.version)) {
    throw new Error("Release package version must have the form <upstream>-patch.<number>");
  }
  return `pi-v${packageManifest.version}`;
}

export function loadReleaseInput(root) {
  const releaseId = releaseIdFromPackage(root);
  const manifest = readJson(join(root, "releases", releaseId, "manifest.json"));
  if (manifest.releaseId !== releaseId) {
    throw new Error(`Package-derived release ID: expected ${releaseId}, found ${String(manifest.releaseId)}`);
  }
  return { releaseId, manifest };
}
