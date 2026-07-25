#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  serializeMetadata,
  verifyChannel,
  verifyChannelSelection,
  verifyReleaseManifest,
  verifyTrustMetadata,
} from "./lib/release-metadata.mjs";

const trustUrl = "https://raw.githubusercontent.com/taylorrowser/pi-wait-for-user/main/releases/release-trust.json";
const rootKeys = new Map([["root-2026-1", `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAEJzllQrM61gGDYr5Q7zfhe+5A/ttP9YpYLsIBsy5bzI=
-----END PUBLIC KEY-----
`]]);
const metadataLimit = 8 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function parseOptions(args) {
  const options = { managePi: false };
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--manage-pi") {
      if (options.managePi) fail("Duplicate --manage-pi");
      options.managePi = true;
    } else if (["--data-root", "--bin-dir", "--legacy-dir"].includes(flag)) {
      const value = args.shift();
      if (!value) fail(`Missing value for ${flag}`);
      options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = resolve(value);
    } else fail("Usage: install.ps1 [-ManagePi] [-DataRoot PATH] [-BinDir PATH] [-LegacyDir PATH]");
  }
  return options;
}

function nativePlatform() {
  const architecture = process.arch === "x64" ? "x64" : process.arch;
  const platform = `windows-${architecture}`;
  if (!/^windows-(?:arm64|x64)$/.test(platform)) fail(`Managed installation does not support ${platform}`);
  return platform;
}

async function download(url, label, expected) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") fail(`${label} URL must use HTTPS`);
  const response = await fetch(parsed, { redirect: "follow", headers: { "user-agent": "pi-wait-for-user-windows-bootstrap/1" } });
  if (!response.ok) fail(`${label} download failed: HTTP ${response.status}`);
  const length = response.headers.get("content-length");
  if (length && Number(length) > (expected?.size ?? metadataLimit)) fail(`${label} download exceeds its signed size`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > (expected?.size ?? metadataLimit)) fail(`${label} download exceeds its signed size`);
  if (expected) {
    if (basename(parsed.pathname) !== expected.name) fail(`${label} artifact name mismatch`);
    if (bytes.length !== expected.size) fail(`${label} size mismatch`);
    if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) fail(`${label} digest mismatch`);
  }
  return bytes;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`Malformed ${label} JSON`);
  }
}

function inspectManagerArchive(path) {
  for (const args of [["-tzf", path], ["-tvzf", path]]) {
    const result = spawnSync("tar", args, { encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0) fail("Verified Manager Release archive is unreadable");
    if (args[0] === "-tzf") {
      for (const raw of result.stdout.split(/\r?\n/)) {
        const name = raw.replace(/^\.\//, "").replace(/\/$/, "");
        if (!name) continue;
        if (name.includes("\\") || name.startsWith("/") || name.split("/").some((part) => !part || part === "." || part === "..")) {
          fail(`Verified Manager Release archive contains an unsafe path: ${raw}`);
        }
      }
    } else if (result.stdout.split(/\r?\n/).some((line) => line && !["-", "d"].includes(line[0]))) {
      fail("Verified Manager Release archive contains an unsupported file kind");
    }
  }
}

const options = parseOptions(process.argv.slice(2));
const platform = nativePlatform();
const temporary = mkdtempSync(join(tmpdir(), "pi-wait-for-user-windows-bootstrap-"));
try {
  const now = new Date();
  const trustBytes = await download(trustUrl, "release trust");
  const trustEnvelope = parseJson(trustBytes, "release trust");
  const authority = verifyTrustMetadata(trustEnvelope, { trustedRootKeys: rootKeys, now });
  const channelBytes = await download(authority.metadata.channelUrl, "Release Channel");
  const channelEnvelope = parseJson(channelBytes, "Release Channel");
  verifyChannelSelection(channelEnvelope, { trust: authority, now });
  const manifestUrl = channelEnvelope.signed.manifest.url;
  const manifestBytes = await download(manifestUrl, "Release Manifest");
  const manifestEnvelope = parseJson(manifestBytes, "Release Manifest");
  verifyChannel(channelEnvelope, { trust: authority, now, manifest: manifestEnvelope });
  const manifest = verifyReleaseManifest(manifestEnvelope, { trust: authority, now });
  const managerArtifact = manifest.manager.artifacts.find((artifact) => artifact.name.endsWith(".tgz"));
  const downstream = manifest.platformArchives.find((archive) => archive.platform === platform);
  if (!managerArtifact) fail("Release Manifest selects no Manager Release archive");
  if (!downstream) fail(`No compatible Downstream Release payload for ${platform}`);
  const baseUrl = new URL("./", manifestUrl);
  const managerBytes = await download(new URL(managerArtifact.name, baseUrl), "Manager Release", managerArtifact);
  const releaseBytes = await download(new URL(downstream.artifact.name, baseUrl), "Downstream Release", downstream.artifact);

  const trustPath = join(temporary, "release-trust.json");
  const channelPath = join(temporary, "channel.json");
  const manifestPath = join(temporary, "release-manifest.json");
  const managerPath = join(temporary, managerArtifact.name);
  const releasePath = join(temporary, downstream.artifact.name);
  for (const [path, bytes] of [
    [trustPath, trustBytes], [channelPath, channelBytes], [manifestPath, manifestBytes],
    [managerPath, managerBytes], [releasePath, releaseBytes],
  ]) writeFileSync(path, bytes, { flag: "wx" });

  inspectManagerArchive(managerPath);
  const extracted = spawnSync("tar", ["-xzf", managerPath, "-C", temporary], { encoding: "utf8", windowsHide: true });
  const runtimePath = join(temporary, "package", "scripts", "lib", "managed-runtime.mjs");
  if (extracted.error || extracted.status !== 0 || !existsSync(runtimePath)) {
    fail(`Verified Manager Release could not be extracted: ${(extracted.stderr || "missing runtime").trim()}`);
  }
  writeFileSync(join(temporary, "package", "scripts", "managed-root-keys.json"), serializeMetadata({
    schemaVersion: 1,
    rootKeys: [...rootKeys].map(([keyId, publicKey]) => ({ keyId, publicKey })),
  }), { flag: "wx" });

  const runtime = await import(pathToFileURL(runtimePath));
  const dataRoot = options.dataRoot || runtime.defaultManagedDataRoot();
  const binDirectory = options.binDir || runtime.defaultManagedBinDirectory();
  runtime.preflightManagedCommandOwnership(dataRoot, { binDirectory, managePi: options.managePi, platform });
  const activationPath = join(dataRoot, "state", "activation.json");
  const prior = existsSync(activationPath) ? runtime.readActivation(dataRoot) : undefined;
  const activation = runtime.installAndActivateFromPinnedRoot({
    dataRoot,
    platform,
    trustEnvelope,
    channelEnvelope,
    manifestEnvelope,
    managerArchive: managerPath,
    releaseArchive: releasePath,
    legacyDirectories: options.legacyDir ? [options.legacyDir] : [],
  });
  const switched = prior && JSON.stringify(prior.active) !== JSON.stringify(activation.active);
  try {
    runtime.installManagedCompatibility(dataRoot, { binDirectory });
    if (options.managePi) runtime.enableManagedOwnership(dataRoot, { binDirectory });
  } catch (error) {
    if (switched) runtime.recoverPrevious(dataRoot);
    throw error;
  }
  console.log(`${options.managePi ? "Managed" : "Side-by-side"} installation ready: ${activation.active.downstreamReleaseId}.`);
  if (options.managePi) console.log("Open a new terminal, then confirm command resolution with: Get-Command pi");
} catch (error) {
  console.error(`pi-wait-for-user: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
