import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  installAndActivateFromManagedConfig,
  readActivation,
  readManagedOwnership,
  readManagedUpdateContext,
  validateActivePair,
} from "./managed-runtime.mjs";
import {
  serializeMetadata,
  verifyChannel,
  verifyChannelSelection,
  verifyReleaseManifest,
  verifyTrustMetadata,
} from "./release-metadata.mjs";

const upstreamLatestVersionUrl = "https://pi.dev/api/latest-version";
const startupThrottleMilliseconds = 24 * 60 * 60 * 1_000;
const metadataLimit = 2 * 1024 * 1024;
const diagnosticLimit = 10;
const idPattern = /^[a-z0-9][a-z0-9.-]+$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(message) {
  throw new Error(message);
}

function paths(dataRoot) {
  const root = resolve(dataRoot);
  return {
    root,
    state: join(root, "state"),
    status: join(root, "state", "update-status.json"),
    startup: join(root, "state", "startup-check.json"),
    startupLock: join(root, "state", "startup-check.lock"),
    hold: join(root, "state", "update-hold.json"),
    diagnostics: join(root, "diagnostics"),
  };
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, serializeMetadata(value));
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function readJson(path, label) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > metadataLimit) fail(`Malformed ${label}`);
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === `Malformed ${label}`) throw error;
    fail(`Malformed ${label}`);
  }
}

function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function during(stage, callback) {
  try {
    return await callback();
  } catch (error) {
    const message = errorMessage(error);
    if (message.startsWith("Managed Update failed during ")) throw error;
    fail(`Managed Update failed during ${stage}: ${message}`);
  }
}

function httpsUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { fail(`Malformed ${label} URL`); }
  if (url.protocol !== "https:") fail(`Malformed ${label} URL: HTTPS is required`);
  return url;
}

function defaultTransport() {
  async function response(url, label) {
    const fetched = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "pi-wait-for-user-managed-update/1" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!fetched.ok) fail(`${label} request returned HTTP ${fetched.status}`);
    return fetched;
  }
  return {
    async json(url, label) {
      const fetched = await response(url, label);
      const text = await fetched.text();
      if (Buffer.byteLength(text) > metadataLimit) fail(`${label} response is too large`);
      try { return JSON.parse(text); } catch { fail(`${label} response is not JSON`); }
    },
    async artifact(url, destination, label, expected) {
      const fetched = await response(url, label);
      const declaredSize = Number(fetched.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize !== expected.size) fail(`${label} download size mismatch`);
      if (!fetched.body) fail(`${label} response has no body`);
      await pipeline(Readable.fromWeb(fetched.body), writeFileStream(destination));
      const size = lstatSync(destination).size;
      if (size !== expected.size) fail(`${label} download size mismatch`);
    },
  };
}

function writeFileStream(path) {
  const descriptor = openSync(path, "wx", 0o600);
  let closed = false;
  return new Writable({
    write(chunk, _encoding, callback) {
      try { writeSync(descriptor, chunk); callback(); } catch (error) { callback(error); }
    },
    final(callback) {
      if (!closed) { closeSync(descriptor); closed = true; }
      callback();
    },
    destroy(error, callback) {
      if (!closed) { closeSync(descriptor); closed = true; }
      callback(error);
    },
  });
}

function compareVersions(left, right) {
  const leftMatch = left.match(versionPattern);
  const rightMatch = right.match(versionPattern);
  if (!leftMatch || !rightMatch) return undefined;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference !== 0) return difference;
  }
  const leftPrerelease = leftMatch[4]?.split(".");
  const rightPrerelease = rightMatch[4]?.split(".");
  if (!leftPrerelease || !rightPrerelease) return leftPrerelease ? -1 : rightPrerelease ? 1 : 0;
  const length = Math.max(leftPrerelease.length, rightPrerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftPrerelease[index];
    const rightPart = rightPrerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function updateStatus(context, selection, manifest, observedUpstreamVersion, upstreamError) {
  const candidateDiffers = manifest.releaseId !== context.active.releaseId
    || manifest.manager.releaseId !== context.active.managerReleaseId
    || selection.manifestSha256 !== context.active.manifestSha256;
  const compatibleUpdate = candidateDiffers ? {
    releaseId: manifest.releaseId,
    managerReleaseId: manifest.manager.releaseId,
    upstreamVersion: manifest.upstream.packageVersion,
    sequence: selection.sequence,
  } : null;
  const newerUpstream = !compatibleUpdate && observedUpstreamVersion
    && compareVersions(observedUpstreamVersion, context.active.upstreamVersion) > 0;
  return {
    schemaVersion: 1,
    type: "managed-update-status",
    checkedAt: new Date().toISOString(),
    active: {
      releaseId: context.active.releaseId,
      managerReleaseId: context.active.managerReleaseId,
      upstreamVersion: context.active.upstreamVersion,
    },
    channel: {
      sequence: selection.sequence,
      releaseId: selection.releaseId,
      manifestSha256: selection.manifestSha256,
    },
    compatibleUpdate,
    patchLag: newerUpstream ? {
      currentReleaseId: context.active.releaseId,
      currentUpstreamVersion: context.active.upstreamVersion,
      observedUpstreamVersion,
    } : null,
    upstream: {
      observedVersion: observedUpstreamVersion || null,
      error: upstreamError || null,
    },
  };
}

function hasExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validDate(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validateStatus(status) {
  if (!hasExactKeys(status, ["schemaVersion", "type", "checkedAt", "active", "channel", "compatibleUpdate", "patchLag", "upstream"])
    || status.schemaVersion !== 1 || status.type !== "managed-update-status" || !validDate(status.checkedAt)
    || !hasExactKeys(status.active, ["releaseId", "managerReleaseId", "upstreamVersion"])
    || !hasExactKeys(status.channel, ["sequence", "releaseId", "manifestSha256"])
    || !hasExactKeys(status.upstream, ["observedVersion", "error"])) fail("Malformed managed update status");
  for (const id of [status.active.releaseId, status.active.managerReleaseId, status.channel.releaseId]) {
    if (typeof id !== "string" || !idPattern.test(id)) fail("Malformed managed update status");
  }
  if (!Number.isSafeInteger(status.channel.sequence) || status.channel.sequence < 1
    || !sha256Pattern.test(status.channel.manifestSha256) || !versionPattern.test(status.active.upstreamVersion)
    || (status.upstream.observedVersion !== null && !versionPattern.test(status.upstream.observedVersion))
    || (status.upstream.error !== null && (typeof status.upstream.error !== "string" || status.upstream.error.length > 500))) {
    fail("Malformed managed update status");
  }
  if (status.compatibleUpdate !== null && (!hasExactKeys(status.compatibleUpdate, ["releaseId", "managerReleaseId", "upstreamVersion", "sequence"])
    || !idPattern.test(status.compatibleUpdate.releaseId) || !idPattern.test(status.compatibleUpdate.managerReleaseId)
    || !versionPattern.test(status.compatibleUpdate.upstreamVersion)
    || !Number.isSafeInteger(status.compatibleUpdate.sequence) || status.compatibleUpdate.sequence < 1)) {
    fail("Malformed managed update status");
  }
  if (status.patchLag !== null && (!hasExactKeys(status.patchLag, ["currentReleaseId", "currentUpstreamVersion", "observedUpstreamVersion"])
    || !idPattern.test(status.patchLag.currentReleaseId) || !versionPattern.test(status.patchLag.currentUpstreamVersion)
    || !versionPattern.test(status.patchLag.observedUpstreamVersion))) fail("Malformed managed update status");
  return status;
}

export function readManagedUpdateStatus(dataRoot) {
  const path = paths(dataRoot).status;
  if (!existsSync(path)) return null;
  return validateStatus(readJson(path, "managed update status"));
}

export async function checkManagedUpdate(dataRoot, options = {}) {
  const transport = options.transport || defaultTransport();
  const now = options.now || new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("Invalid Managed Update check date");
  const context = await during("local validation", async () => readManagedUpdateContext(dataRoot));
  const priorChannelUrl = httpsUrl(context.trustEnvelope.signed.channelUrl, "authenticated Channel");
  const trustUrl = new URL("release-trust.json", priorChannelUrl).href;
  const trustEnvelope = await during("trust discovery", () => transport.json(trustUrl, "release trust metadata"));
  const authority = await during("trust verification", async () => verifyTrustMetadata(trustEnvelope, {
    trustedRootKeys: context.rootKeys,
    now,
    accepted: context.accepted.trust,
  }));
  const channelUrl = httpsUrl(authority.metadata.channelUrl, "authenticated Channel").href;
  const channelEnvelope = await during("Channel discovery", () => transport.json(channelUrl, "Release Channel"));
  const selection = await during("Channel verification", async () => verifyChannelSelection(channelEnvelope, {
    trust: authority,
    now,
    accepted: context.accepted.channel,
  }));
  const manifestUrl = httpsUrl(channelEnvelope.signed.manifest.url, "Release Manifest").href;
  const manifestEnvelope = await during("Release Manifest discovery", () => transport.json(manifestUrl, "Release Manifest"));
  await during("Release Manifest verification", async () => verifyChannel(channelEnvelope, {
    trust: authority,
    now,
    manifest: manifestEnvelope,
    accepted: context.accepted.channel,
  }));
  const manifest = await during("Release Manifest verification", async () => verifyReleaseManifest(manifestEnvelope, { trust: authority, now }));

  let observedUpstreamVersion;
  let upstreamError;
  try {
    const latest = await transport.json(options.upstreamUrl || upstreamLatestVersionUrl, "upstream Pi latest version");
    if (typeof latest?.version !== "string" || !versionPattern.test(latest.version.trim())) fail("Malformed upstream Pi latest-version response");
    observedUpstreamVersion = latest.version.trim();
  } catch (error) {
    upstreamError = errorMessage(error);
  }

  const status = updateStatus(context, selection, manifest, observedUpstreamVersion, upstreamError);
  status.checkedAt = now.toISOString();
  if (options.cache !== false) atomicWrite(paths(dataRoot).status, status);
  const common = {
    active: status.active,
    channel: status.channel,
    upstreamError,
    observedUpstreamVersion,
    source: { trustEnvelope, channelEnvelope, manifestEnvelope, manifestUrl },
  };
  if (status.compatibleUpdate) return { kind: "compatible-update", ...common, candidate: status.compatibleUpdate };
  if (status.patchLag) return { kind: "patch-lag", ...common, patchLag: status.patchLag };
  return { kind: "current", ...common };
}

function failureStage(error, fallback) {
  return errorMessage(error).match(/^Managed Update failed during ([^:]+):/)?.[1] || fallback;
}

function recordDiagnostic(dataRoot, stage, error) {
  const directory = paths(dataRoot).diagnostics;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    atomicWrite(join(directory, `${Date.now()}-${randomUUID()}.json`), {
      schemaVersion: 1,
      type: "managed-update-failure",
      stage,
      recordedAt: new Date().toISOString(),
      error: errorMessage(error),
    });
    const diagnostics = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
    for (const name of diagnostics.slice(0, Math.max(0, diagnostics.length - diagnosticLimit))) unlinkSync(join(directory, name));
  } catch {
    // Diagnostics must never hide the Managed Update failure.
  }
}

function clearExactUpdateHold(dataRoot, releaseId) {
  const holdPath = paths(dataRoot).hold;
  if (!existsSync(holdPath)) return;
  const hold = readJson(holdPath, "Update Hold");
  if (hold?.schemaVersion !== 1 || hold.type !== "update-hold" || !idPattern.test(hold.releaseId)
    || typeof hold.createdAt !== "string") fail("Malformed Update Hold");
  if (hold.releaseId === releaseId) unlinkSync(holdPath);
}

function activatedStatus(checked, candidate, now) {
  const patchLag = checked.observedUpstreamVersion
    && compareVersions(checked.observedUpstreamVersion, candidate.upstreamVersion) > 0
    ? {
        currentReleaseId: candidate.releaseId,
        currentUpstreamVersion: candidate.upstreamVersion,
        observedUpstreamVersion: checked.observedUpstreamVersion,
      }
    : null;
  return {
    schemaVersion: 1,
    type: "managed-update-status",
    checkedAt: now.toISOString(),
    active: {
      releaseId: candidate.releaseId,
      managerReleaseId: candidate.managerReleaseId,
      upstreamVersion: candidate.upstreamVersion,
    },
    channel: checked.channel,
    compatibleUpdate: null,
    patchLag,
    upstream: { observedVersion: checked.observedUpstreamVersion || null, error: checked.upstreamError || null },
  };
}

export async function performManagedUpdate(dataRoot, options = {}) {
  let stage = "discovery";
  let temporary;
  try {
    const checked = await checkManagedUpdate(dataRoot, options);
    if (checked.kind !== "compatible-update") return checked;
    const manifest = checked.source.manifestEnvelope.signed;
    const platform = readActivation(dataRoot).active.platform;
    const downstream = manifest.platformArchives.find((entry) => entry.platform === platform);
    if (!downstream) fail(`Managed Update failed during candidate selection: platform is not declared: ${platform}`);
    if (manifest.manager.artifacts.length !== 1) fail("Managed Update failed during candidate selection: Release Manifest must select one Manager Release artifact");
    const managerArtifact = manifest.manager.artifacts[0];
    temporary = mkdtempSync(join(tmpdir(), "pi-managed-update-"));
    const managerArchive = join(temporary, basename(managerArtifact.name));
    const releaseArchive = join(temporary, basename(downstream.artifact.name));
    stage = "Manager Release download";
    await during(stage, () => (options.transport || defaultTransport()).artifact(
      new URL(managerArtifact.name, checked.source.manifestUrl).href,
      managerArchive,
      "Manager Release",
      managerArtifact,
    ));
    stage = "Downstream Release download";
    await during(stage, () => (options.transport || defaultTransport()).artifact(
      new URL(downstream.artifact.name, checked.source.manifestUrl).href,
      releaseArchive,
      "Downstream Release",
      downstream.artifact,
    ));
    stage = "verification and activation";
    const activation = await during(stage, async () => installAndActivateFromManagedConfig({
      dataRoot,
      trustEnvelope: checked.source.trustEnvelope,
      channelEnvelope: checked.source.channelEnvelope,
      manifestEnvelope: checked.source.manifestEnvelope,
      managerArchive,
      releaseArchive,
      now: options.now || new Date(),
      checkpoint: options.checkpoint,
    }));
    clearExactUpdateHold(dataRoot, checked.candidate.releaseId);
    atomicWrite(paths(dataRoot).status, activatedStatus(checked, checked.candidate, options.now || new Date()));
    return { kind: "activated", active: checked.candidate, channel: checked.channel, activation };
  } catch (error) {
    recordDiagnostic(dataRoot, failureStage(error, stage), error);
    throw error;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

export async function runManagedUpdate(dataRoot, options = {}) {
  const managed = await performManagedUpdate(dataRoot, options);
  await options.managedPhaseComplete?.(managed);
  if (!options.all) return { managed, exitCode: 0, partial: false };
  const selected = validateActivePair(dataRoot);
  let packageExitCode;
  let packageError;
  try {
    packageExitCode = await options.packagePhase(selected);
  } catch (error) {
    packageExitCode = 1;
    packageError = errorMessage(error);
  }
  return {
    managed,
    packageExitCode,
    packageError,
    exitCode: packageExitCode,
    partial: packageExitCode !== 0,
  };
}

function readUpdateHold(dataRoot) {
  const holdPath = paths(dataRoot).hold;
  if (!existsSync(holdPath)) return null;
  const hold = readJson(holdPath, "Update Hold");
  if (hold?.schemaVersion !== 1 || hold.type !== "update-hold" || !idPattern.test(hold.releaseId)
    || typeof hold.createdAt !== "string") fail("Malformed Update Hold");
  return hold;
}

export function cachedManagedStartupNotice(dataRoot, options = {}) {
  const environment = options.environment || process.env;
  if (!options.interactive || environment.PI_SKIP_VERSION_CHECK || environment.PI_OFFLINE) return null;
  const status = readManagedUpdateStatus(dataRoot);
  if (!status) return null;
  const active = readActivation(dataRoot).active;
  if (status.active.releaseId !== active.downstreamReleaseId) return null;
  const hold = readUpdateHold(dataRoot);
  if (status.compatibleUpdate && hold?.releaseId !== status.compatibleUpdate.releaseId) {
    return `A compatible Downstream Release is available: ${status.compatibleUpdate.releaseId}. Run \`pi update\`.`;
  }
  if (status.patchLag) {
    return `Patch Lag: ${status.patchLag.currentReleaseId} is based on upstream Pi ${status.patchLag.currentUpstreamVersion}; upstream Pi ${status.patchLag.observedUpstreamVersion} is newer and no compatible Downstream Release is available yet.`;
  }
  return null;
}

export function claimManagedStartupCheck(dataRoot, options = {}) {
  const environment = options.environment || process.env;
  if (environment.PI_SKIP_VERSION_CHECK || environment.PI_OFFLINE || options.offline) return false;
  const now = options.now || new Date();
  const selected = paths(dataRoot);
  mkdirSync(selected.state, { recursive: true, mode: 0o700 });
  let lock;
  try { lock = openSync(selected.startupLock, "wx", 0o600); } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  closeSync(lock);
  try {
    if (existsSync(selected.startup)) {
      const state = readJson(selected.startup, "startup check state");
      if (state?.schemaVersion !== 1 || state.type !== "managed-startup-check" || typeof state.lastAttemptAt !== "string") {
        fail("Malformed startup check state");
      }
      const elapsed = now.getTime() - Date.parse(state.lastAttemptAt);
      if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < startupThrottleMilliseconds) return false;
    }
    atomicWrite(selected.startup, {
      schemaVersion: 1,
      type: "managed-startup-check",
      lastAttemptAt: now.toISOString(),
    });
    return true;
  } finally {
    rmSync(selected.startupLock, { force: true });
  }
}

export function formatManagedStatus(dataRoot) {
  const context = readManagedUpdateContext(dataRoot);
  const status = readManagedUpdateStatus(dataRoot);
  const hold = readUpdateHold(dataRoot);
  let stock = "not recorded";
  if (existsSync(join(paths(dataRoot).state, "entrypoints.json"))) {
    const identity = readManagedOwnership(dataRoot).stock;
    stock = identity ? `${identity.version} at ${identity.resolvedPath}` : "none recorded";
  }
  const sessions = context.active.compatibility.sessions.identities.map((entry) => `${entry.id}@${entry.version}`).join(", ");
  const protocols = context.active.compatibility.sessions.readableCoreProtocolVersions.join(", ");
  const question = context.active.compatibility.questionTool;
  const cacheMatches = status?.active.releaseId === context.active.releaseId;
  const channel = cacheMatches
    ? `${status.channel.sequence} (candidate ${status.channel.releaseId})`
    : `${context.accepted.channel.sequence} (candidate ${context.accepted.channel.releaseId}; cached check unavailable)`;
  const compatible = cacheMatches && status.compatibleUpdate ? status.compatibleUpdate.releaseId : "none";
  const patchLag = cacheMatches && status.patchLag
    ? `upstream Pi ${status.patchLag.observedUpstreamVersion} is newer than active ${status.patchLag.currentUpstreamVersion}`
    : "none";
  return [
    `Active Downstream Release: ${context.active.releaseId}`,
    `Based on Upstream Pi: ${context.active.upstreamVersion}`,
    `Active Manager Release: ${context.active.managerReleaseId}`,
    `Platform: ${context.active.platform}`,
    `Session identities: ${sessions}`,
    `Readable durable-deferral protocol versions: ${protocols}`,
    `Question Tool handler: ${question.handlerId}@${question.handlerVersion}`,
    `Stock Pi: ${stock}`,
    `Channel sequence: ${channel}`,
    `Compatible Downstream Update: ${compatible}`,
    `Patch Lag: ${patchLag}`,
    `Update Hold: ${hold ? hold.releaseId : "none"}`,
  ].join("\n");
}
