#!/bin/sh
set -eu

release_id="pi-v0.81.1-patch.11"

for command in node tar; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "pi-wait-for-user: required command not found: $command" >&2
    exit 1
  fi
done

node_version=$(node -p '`${process.versions.node.split(".")[0]}.${process.versions.node.split(".")[1]}`')
node_major=${node_version%%.*}
node_minor=${node_version#*.}
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 19 ]; }; then
  echo "pi-wait-for-user: managed installation requires Node.js 22.19 or newer" >&2
  exit 1
fi

exec node --input-type=module - "$@" <<'MANAGED_BOOTSTRAP'
import { createHash, createPublicKey, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const trustUrl = "https://raw.githubusercontent.com/taylorrowser/pi-wait-for-user/main/releases/release-trust.json";
const rootKeys = new Map([["root-2026-1", `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAEJzllQrM61gGDYr5Q7zfhe+5A/ttP9YpYLsIBsy5bzI=
-----END PUBLIC KEY-----
`]]);
const metadataLimit = 8 * 1024 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/;
const platformPattern = /^(?:darwin-arm64|linux-(?:arm64|x64))$/;

function fail(message) { throw new Error(message); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys, label) {
  if (!plain(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(`Malformed ${label}`);
  return value;
}
function text(value, label, pattern) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) fail(`Malformed ${label}`);
  return value;
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`Malformed ${label}`);
  return value;
}
function date(value, label) {
  const parsed = Date.parse(text(value, label));
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(`Malformed ${label}`);
  return parsed;
}
function httpsUrl(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch { fail(`Malformed ${label}`); }
  if (parsed.protocol !== "https:") fail(`${label} must use HTTPS`);
  return parsed;
}
function safeName(value, label) {
  text(value, label);
  if (value.includes("/") || value.includes("\\") || value === "." || value === "..") fail(`Malformed ${label}`);
  return value;
}
function artifact(value, label) {
  exact(value, ["name", "sha256", "size"], label);
  safeName(value.name, `${label} name`);
  text(value.sha256, `${label} digest`, sha256Pattern);
  integer(value.size, `${label} size`);
  return value;
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function verifySignatures(envelope, keys, label) {
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0) fail(`Malformed ${label} signatures`);
  for (const signature of envelope.signatures) {
    exact(signature, ["keyId", "algorithm", "signature"], `${label} signature`);
    if (signature.algorithm !== "ed25519" || typeof signature.signature !== "string") fail(`Malformed ${label} signature`);
    const key = keys.get(signature.keyId);
    if (!key) continue;
    try {
      const publicKey = createPublicKey(key);
      if (publicKey.asymmetricKeyType === "ed25519" && verify(
        null,
        Buffer.from(canonical(envelope.signed)),
        publicKey,
        Buffer.from(signature.signature, "base64"),
      )) return signature.keyId;
    } catch { /* Try any other authorized signature. */ }
  }
  fail(`Invalid or unauthorized ${label} signature`);
}
function envelope(value, type, payloadKeys) {
  exact(value, ["signed", "signatures"], `${type} metadata`);
  exact(value.signed, payloadKeys, `${type} payload`);
  if (value.signed.schemaVersion !== 1) fail(`Unknown ${type} schema version ${String(value.signed.schemaVersion)}`);
  if (value.signed.type !== type) fail(`Malformed ${type} metadata`);
  return value;
}
async function download(url, label, expected) {
  const parsed = httpsUrl(url, `${label} URL`);
  const response = await fetch(parsed, { redirect: "follow", headers: { "user-agent": "pi-wait-for-user-bootstrap/1" } });
  if (!response.ok) fail(`${label} download failed: HTTP ${response.status}`);
  const length = response.headers.get("content-length");
  if (length && Number(length) > (expected?.size ?? metadataLimit)) fail(`${label} download exceeds its signed size`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > (expected?.size ?? metadataLimit)) fail(`${label} download exceeds its signed size`);
  if (expected) {
    if (bytes.length !== expected.size) fail(`${label} size mismatch`);
    if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) fail(`${label} digest mismatch`);
  }
  return bytes;
}
function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { fail(`Malformed ${label} JSON`); }
}
function delegatedKeys(trust, now) {
  const keys = new Map();
  if (!Array.isArray(trust.signed.releaseKeys) || trust.signed.releaseKeys.length === 0) fail("Malformed release trust keys");
  for (const entry of trust.signed.releaseKeys) {
    exact(entry, ["keyId", "algorithm", "publicKey", "expires", "revoked"], "release trust key");
    text(entry.keyId, "release trust key ID");
    if (entry.algorithm !== "ed25519" || typeof entry.revoked !== "boolean") fail("Malformed release trust key");
    if (!entry.revoked && date(entry.expires, "release key expiry") > now) keys.set(entry.keyId, entry.publicKey);
  }
  if (keys.size === 0) fail("Release trust authorizes no unexpired release key");
  return keys;
}
function nativePlatform() {
  const os = process.platform === "darwin" ? "darwin" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch;
  const platform = `${os}-${arch}`;
  if (!platformPattern.test(platform)) fail(`Managed installation does not support ${platform}`);
  return platform;
}
function inspectManagerArchive(path) {
  const listing = spawnSync("tar", ["-tzf", path], { encoding: "utf8" });
  if (listing.error || listing.status !== 0) fail("Verified Manager Release archive is unreadable");
  for (const raw of listing.stdout.split("\n")) {
    if (!raw) continue;
    const name = raw.replace(/^\.\//, "").replace(/\/$/, "");
    if (!name) continue;
    if (name.includes("\\") || name.startsWith("/") || name.split("/").some((part) => !part || part === "." || part === "..")) {
      fail(`Verified Manager Release archive contains an unsafe path: ${raw}`);
    }
  }
  const verbose = spawnSync("tar", ["-tvzf", path], { encoding: "utf8" });
  if (verbose.error || verbose.status !== 0 || verbose.stdout.split("\n").some((line) => line && !["-", "d"].includes(line[0]))) {
    fail("Verified Manager Release archive contains an unsupported file kind");
  }
}
function parseOptions(args) {
  const options = { managePi: false, forwarded: [] };
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--manage-pi") {
      if (options.managePi) fail("Duplicate --manage-pi");
      options.managePi = true;
    } else if (["--data-root", "--bin-dir", "--legacy-dir"].includes(flag)) {
      const value = args.shift();
      if (!value) fail(`Missing value for ${flag}`);
      options.forwarded.push(flag, value);
    } else fail("Usage: install.sh [--manage-pi] [--data-root PATH] [--bin-dir PATH] [--legacy-dir PATH]");
  }
  return options;
}

const platform = nativePlatform();
const temporary = mkdtempSync(join(tmpdir(), "pi-wait-for-user-bootstrap-"));
try {
  const now = Date.now();
  const trustBytes = await download(trustUrl, "release trust");
  const trust = envelope(parseJson(trustBytes, "release trust"), "release-trust", [
    "schemaVersion", "type", "version", "expires", "channelUrl", "releaseKeys",
  ]);
  integer(trust.signed.version, "release trust version", 1);
  if (date(trust.signed.expires, "release trust expiry") <= now) fail("Release trust metadata expired");
  verifySignatures(trust, rootKeys, "release trust");
  const releaseKeys = delegatedKeys(trust, now);

  const channelBytes = await download(trust.signed.channelUrl, "Release Channel");
  const channel = envelope(parseJson(channelBytes, "Release Channel"), "release-channel", [
    "schemaVersion", "type", "sequence", "expires", "manifest",
  ]);
  integer(channel.signed.sequence, "Release Channel sequence", 1);
  if (date(channel.signed.expires, "Release Channel expiry") <= now) fail("Release Channel expired");
  exact(channel.signed.manifest, ["releaseId", "url", "sha256"], "Release Channel manifest selection");
  text(channel.signed.manifest.releaseId, "selected Downstream Release ID");
  text(channel.signed.manifest.sha256, "selected Release Manifest digest", sha256Pattern);
  verifySignatures(channel, releaseKeys, "Release Channel");

  const manifestBytes = await download(channel.signed.manifest.url, "Release Manifest");
  if (createHash("sha256").update(manifestBytes).digest("hex") !== channel.signed.manifest.sha256) fail("Release Channel manifest digest mismatch");
  const manifestEnvelope = envelope(parseJson(manifestBytes, "Release Manifest"), "release-manifest", [
    "schemaVersion", "type", "releaseId", "tag", "publishedAt", "upstream", "patches", "compatibility",
    "manager", "bootstrap", "platformArchives", "releaseGates", "provenance", "releaseNotes",
  ]);
  verifySignatures(manifestEnvelope, releaseKeys, "Release Manifest");
  const manifest = manifestEnvelope.signed;
  if (manifest.releaseId !== channel.signed.manifest.releaseId || manifest.tag !== manifest.releaseId) fail("Release Channel manifest identity mismatch");
  exact(manifest.manager, ["releaseId", "compatibleReleaseManifestVersions", "artifacts"], "Manager Release");
  text(manifest.manager.releaseId, "Manager Release ID");
  if (!Array.isArray(manifest.manager.compatibleReleaseManifestVersions) || !manifest.manager.compatibleReleaseManifestVersions.includes(1)) fail("Incompatible Manager Release");
  if (!Array.isArray(manifest.manager.artifacts) || manifest.manager.artifacts.length !== 1) fail("Release Manifest must select one exact Manager Release artifact");
  const managerArtifact = artifact(manifest.manager.artifacts[0], "Manager Release artifact");
  if (!Array.isArray(manifest.platformArchives)) fail("Malformed platform archives");
  const selected = manifest.platformArchives.find((entry) => entry?.platform === platform);
  if (!selected || !Array.isArray(selected.payload) || selected.payload.length === 0) fail(`No compatible Downstream Release payload for ${platform}`);
  exact(selected, ["platform", "artifact", "payload"], "platform archive");
  const releaseArtifact = artifact(selected.artifact, "Downstream Release artifact");
  const baseUrl = new URL("./", channel.signed.manifest.url);
  const managerBytes = await download(new URL(managerArtifact.name, baseUrl), "Manager Release", managerArtifact);
  const releaseBytes = await download(new URL(releaseArtifact.name, baseUrl), "Downstream Release", releaseArtifact);

  const trustPath = join(temporary, "release-trust.json");
  const channelPath = join(temporary, "channel.json");
  const manifestPath = join(temporary, "release-manifest.json");
  const managerPath = join(temporary, managerArtifact.name);
  const releasePath = join(temporary, releaseArtifact.name);
  writeFileSync(trustPath, trustBytes, { mode: 0o600 });
  writeFileSync(channelPath, channelBytes, { mode: 0o600 });
  writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
  writeFileSync(managerPath, managerBytes, { mode: 0o600 });
  writeFileSync(releasePath, releaseBytes, { mode: 0o600 });

  inspectManagerArchive(managerPath);
  const extracted = spawnSync("tar", ["-xzf", managerPath, "-C", temporary, "--no-same-owner"], { encoding: "utf8" });
  if (extracted.error || extracted.status !== 0 || !existsSync(join(temporary, "package", "scripts", "lib", "managed-runtime.mjs"))) {
    fail(`Verified Manager Release could not be extracted: ${(extracted.stderr || "missing runtime").trim()}`);
  }
  writeFileSync(join(temporary, "package", "scripts", "managed-root-keys.json"), `${JSON.stringify({
    schemaVersion: 1,
    rootKeys: [...rootKeys].map(([keyId, publicKey]) => ({ keyId, publicKey })),
  }, null, 2)}\n`, { mode: 0o444 });

  const runtime = await import(pathToFileURL(join(temporary, "package", "scripts", "lib", "managed-runtime.mjs")));
  const options = parseOptions(process.argv.slice(2));
  const values = new Map();
  for (let index = 0; index < options.forwarded.length; index += 2) values.set(options.forwarded[index], options.forwarded[index + 1]);
  const dataRoot = resolve(values.get("--data-root") || runtime.defaultManagedDataRoot());
  const binDirectory = resolve(values.get("--bin-dir") || runtime.defaultManagedBinDirectory());
  runtime.preflightManagedCommandOwnership(dataRoot, { binDirectory, managePi: options.managePi });
  const activationPath = join(dataRoot, "state", "activation.json");
  const prior = existsSync(activationPath) ? runtime.readActivation(dataRoot) : undefined;
  const activation = runtime.installAndActivateFromPinnedRoot({
    dataRoot,
    platform,
    trustEnvelope: trust,
    channelEnvelope: channel,
    manifestEnvelope,
    managerArchive: managerPath,
    releaseArchive: releasePath,
    legacyDirectories: values.has("--legacy-dir") ? [resolve(values.get("--legacy-dir"))] : [],
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
  if (options.managePi) console.log("Run `hash -r`, then confirm this shell with: command -v pi");
  const adoption = runtime.readLegacyInstallationAdoption(dataRoot);
  if (adoption) {
    console.log(adoption.disposition === "adopted-after-signed-verification"
      ? `Adopted verified Legacy Downstream Installation from ${adoption.legacyPath}.`
      : `Legacy Downstream Installation was not signed-payload identical and was left untouched at ${adoption.legacyPath}.`);
    console.log(adoption.cleanup);
  }
} catch (error) {
  console.error(`pi-wait-for-user: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
MANAGED_BOOTSTRAP
