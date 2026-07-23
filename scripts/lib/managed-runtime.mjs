import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readPinnedRootKeys } from "./managed-command.mjs";
import {
  canonicalJson,
  createPayloadInventory,
  serializeMetadata,
  sha256File,
  verifyChannel,
  verifyReleaseManifest,
  verifyTrustMetadata,
} from "./release-metadata.mjs";

const idPattern = /^[a-z0-9][a-z0-9.-]+$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const supportedPlatforms = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
const rootKeyProvenanceType = Object.freeze({ callerSelected: "caller-selected", installerPinned: "installer-pinned" });
const managedDiagnosticLimit = 10;
const activeLifecycleCapabilities = new WeakSet();
const receiptKeys = [
  "schemaVersion", "type", "ownedPath", "managerReleaseId", "downstreamReleaseId", "platform",
  "manifestSha256", "sourceArtifact", "verifiedAt", "payload",
];

function fail(message) {
  throw new Error(message);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactObject(value, label, keys) {
  if (!plainObject(value) || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    fail(`Malformed ${label}`);
  }
  return value;
}

function expectString(value, label, pattern) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) fail(`Malformed ${label}`);
  return value;
}

function expectDate(value, label) {
  expectString(value, label);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) fail(`Malformed ${label}`);
  return value;
}

function readJson(path, label = basename(path)) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`Malformed ${label}`);
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`Malformed ${label}`);
  }
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function digestBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function metadataDigest(value) {
  return digestBytes(serializeMetadata(value));
}

function ensurePlatform(platform) {
  if (!supportedPlatforms.has(platform)) fail(`Unsupported managed platform: ${platform}`);
}

function ensureIdentifier(value, label) {
  return expectString(value, label, idPattern);
}

function ensureRelativePath(value, label) {
  expectString(value, label);
  if (value.includes("\\") || value.startsWith("/")
    || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail(`Malformed ${label}`);
  }
  return value;
}

function ensureInside(parent, path, label) {
  const parentPath = resolve(parent);
  const candidate = resolve(path);
  if (candidate === parentPath || !candidate.startsWith(`${parentPath}${sep}`)) fail(`${label} escapes manager ownership`);
  return candidate;
}

function ensureNoSymlinkPath(parent, path, label) {
  const parentPath = resolve(parent);
  const candidate = ensureInside(parentPath, path, label);
  let cursor = parentPath;
  for (const component of relative(parentPath, candidate).split(sep)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) fail(`${label} contains a symbolic link`);
  }
  return candidate;
}

function mkdir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function ensureManagedDirectory(path) {
  if (!existsSync(path)) mkdir(path);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`Managed state path is foreign: ${path}`);
}

function atomicWrite(path, value) {
  mkdir(dirname(path));
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, typeof value === "string" ? value : serializeMetadata(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  try {
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch {
    // Some filesystems do not allow directory fsync. Atomic rename still prevents a half-record.
  }
}

export function defaultManagedDataRoot(environment = process.env, platform = process.platform) {
  if (platform === "darwin") return `${environment.HOME}/Library/Application Support/pi-wait-for-user`;
  if (platform === "linux") return `${environment.XDG_DATA_HOME || `${environment.HOME}/.local/share`}/pi-wait-for-user`;
  fail("Managed Installation supports macOS and Linux");
}

export function defaultManagedBinDirectory(environment = process.env) {
  if (!environment.HOME) fail("HOME is required to select the managed bin directory");
  return join(environment.HOME, ".local", "bin");
}

function layout(dataRoot) {
  const root = resolve(dataRoot);
  return {
    root,
    state: join(root, "state"),
    activation: join(root, "state", "activation.json"),
    accepted: join(root, "state", "accepted-metadata.json"),
    config: join(root, "state", "config.json"),
    managers: join(root, "managers"),
    releases: join(root, "downstream-releases"),
    receipts: join(root, "receipts"),
    artifacts: join(root, "artifacts"),
    leases: join(root, "leases"),
    temporary: join(root, "tmp"),
    diagnostics: join(root, "diagnostics"),
    pending: join(root, "state", "pending-cleanup.json"),
    lock: join(root, "state", "lifecycle.lock"),
  };
}

export function managedStateDirectory(dataRoot) {
  const paths = layout(dataRoot);
  ensureManagedDirectory(paths.root);
  ensureManagedDirectory(paths.state);
  return paths.state;
}

function managedStatePath(dataRoot, name) {
  if (typeof name !== "string" || basename(name) !== name || name === "." || name === "..") {
    fail("Malformed managed state filename");
  }
  return join(managedStateDirectory(dataRoot), name);
}

export function readManagedStateJson(dataRoot, name, label, { maximumSize = 2 * 1024 * 1024 } = {}) {
  const path = managedStatePath(dataRoot, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumSize) fail(`Malformed ${label}`);
  return readJson(path, label);
}

export function writeManagedStateJson(dataRoot, name, value) {
  const path = managedStatePath(dataRoot, name);
  if (pathExists(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("Managed state path is foreign");
  }
  atomicWrite(path, value);
}

function publishStateFileExclusive(stateDirectory, path, value) {
  const temporary = join(stateDirectory, `.${basename(path)}.tmp-${randomUUID()}`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, serializeMetadata(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, path);
    const stat = lstatSync(path);
    return { published: true, identity: { dev: stat.dev, ino: stat.ino } };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return { published: false, identity: null };
  } finally {
    unlinkSync(temporary);
  }
}

export function publishManagedStateFileExclusive(dataRoot, name, value) {
  const state = managedStateDirectory(dataRoot);
  return publishStateFileExclusive(state, managedStatePath(dataRoot, name), value);
}

export function managedStateFileIsOwned(dataRoot, name, identity) {
  const path = managedStatePath(dataRoot, name);
  try {
    const stat = lstatSync(path);
    return Boolean(identity && stat.dev === identity.dev && stat.ino === identity.ino);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function removeManagedStateFileIfOwned(dataRoot, name, identity) {
  const path = managedStatePath(dataRoot, name);
  if (!managedStateFileIsOwned(dataRoot, name, identity)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function initializeLayout(dataRoot) {
  const paths = layout(dataRoot);
  for (const path of [paths.root, paths.state, paths.managers, paths.releases, paths.receipts, paths.artifacts, paths.leases, paths.temporary, paths.diagnostics]) {
    ensureManagedDirectory(path);
  }
  return paths;
}

export function managedProcessStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (process.platform === "linux") {
    try {
      const value = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = value.slice(value.lastIndexOf(") ") + 2).trim().split(/\s+/);
      return fields[19] ? `linux-proc-start:${fields[19]}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    const startedAt = result.status === 0 ? result.stdout.trim() : "";
    return startedAt ? `darwin-ps-start:${startedAt}` : null;
  }
  return null;
}

export function managedProcessIdentityIsLive(pid, startIdentity) {
  return typeof startIdentity === "string" && managedProcessStartIdentity(pid) === startIdentity;
}

function currentManagedProcessStartIdentity() {
  const identity = managedProcessStartIdentity(process.pid);
  if (!identity) fail("Cannot identify the managed lifecycle process");
  return identity;
}

function publishLifecycleLock(paths, lock) {
  const result = publishStateFileExclusive(paths.state, paths.lock, lock);
  if (result.published) {
    try {
      const directory = openSync(paths.state, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch {
      // The complete hard-linked lock remains atomic when directory fsync is unavailable.
    }
  }
  return result.published;
}

function unlinkIfOwned(path, identity) {
  try {
    const stat = lstatSync(path);
    if (stat.dev !== identity.dev || stat.ino !== identity.ino) return false;
    unlinkSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function acquireLifecycleRecoveryOwner(paths, staleToken, claimantToken) {
  const ownerPath = join(paths.state, `lifecycle-recovery-${digestBytes(String(staleToken))}.owner`);
  const owner = {
    schemaVersion: 1,
    type: "lifecycle-lock-recovery-owner",
    staleToken,
    pid: process.pid,
    processStartIdentity: currentManagedProcessStartIdentity(),
    claimantToken,
    claimedAt: new Date().toISOString(),
  };
  const published = publishStateFileExclusive(paths.state, ownerPath, owner);
  if (published.published) return { path: ownerPath, identity: published.identity };
  const active = readJson(ownerPath, "lifecycle recovery owner");
  exactObject(active, "lifecycle recovery owner", ["schemaVersion", "type", "staleToken", "pid", "processStartIdentity", "claimantToken", "claimedAt"]);
  if (active.schemaVersion !== 1 || active.type !== "lifecycle-lock-recovery-owner"
    || active.staleToken !== staleToken || !Number.isSafeInteger(active.pid) || active.pid < 1
    || typeof active.processStartIdentity !== "string" || !active.processStartIdentity) {
    fail("Malformed lifecycle recovery owner");
  }
  expectString(active.claimantToken, "lifecycle recovery claimant token");
  expectDate(active.claimedAt, "lifecycle recovery claim date");
  if (managedProcessIdentityIsLive(active.pid, active.processStartIdentity)) {
    fail("Stale lifecycle lock recovery is already active");
  }
  const stat = lstatSync(ownerPath);
  if (!unlinkIfOwned(ownerPath, { dev: stat.dev, ino: stat.ino })) {
    return acquireLifecycleRecoveryOwner(paths, staleToken, claimantToken);
  }
  return acquireLifecycleRecoveryOwner(paths, staleToken, claimantToken);
}

function acquireLifecycleLock(dataRoot, operation) {
  expectString(operation, "lifecycle operation");
  const paths = initializeLayout(dataRoot);
  const token = randomUUID();
  const lock = {
    schemaVersion: 1,
    pid: process.pid,
    processStartIdentity: currentManagedProcessStartIdentity(),
    token,
    operation,
    startedAt: new Date().toISOString(),
  };
  if (!publishLifecycleLock(paths, lock)) {
    const active = readJson(paths.lock, "lifecycle lock");
    exactObject(active, "lifecycle lock", ["schemaVersion", "pid", "processStartIdentity", "token", "operation", "startedAt"]);
    if (active.schemaVersion !== 1 || !Number.isSafeInteger(active.pid) || active.pid < 1) fail("Malformed lifecycle lock");
    expectString(active.processStartIdentity, "lifecycle lock process identity");
    expectString(active.token, "lifecycle lock token");
    expectString(active.operation, "lifecycle lock operation");
    expectDate(active.startedAt, "lifecycle lock start date");
    if (managedProcessIdentityIsLive(active.pid, active.processStartIdentity)) {
      fail(`Managed lifecycle operation already active: ${String(active.operation)}`);
    }
    const recoveryPath = join(paths.state, `lifecycle-recovery-${digestBytes(String(active.token))}.json`);
    try {
      linkSync(paths.lock, recoveryPath);
    } catch (recoveryError) {
      if (recoveryError?.code !== "EEXIST") throw recoveryError;
      const lockStat = lstatSync(paths.lock);
      const recoveryStat = lstatSync(recoveryPath);
      if (lockStat.dev !== recoveryStat.dev || lockStat.ino !== recoveryStat.ino) {
        fail("Stale lifecycle lock recovery record does not match the interrupted lock");
      }
    }
    const recoveryOwner = acquireLifecycleRecoveryOwner(paths, active.token, token);
    try {
      const current = readJson(paths.lock, "lifecycle lock");
      const claimed = readJson(recoveryPath, "lifecycle recovery claim");
      const staleStat = lstatSync(paths.lock);
      const recoveryStat = lstatSync(recoveryPath);
      if (current.token !== active.token || claimed.token !== active.token
        || staleStat.dev !== recoveryStat.dev || staleStat.ino !== recoveryStat.ino) {
        fail("Lifecycle lock changed during stale recovery");
      }
      if (!unlinkIfOwned(paths.lock, { dev: staleStat.dev, ino: staleStat.ino })) {
        return acquireLifecycleLock(dataRoot, operation);
      }
      atomicWrite(recoveryPath, {
        schemaVersion: 1,
        type: "lifecycle-lock-recovery",
        staleToken: active.token,
        claimedByToken: token,
        claimedAt: new Date().toISOString(),
      });
      if (!publishLifecycleLock(paths, lock)) return acquireLifecycleLock(dataRoot, operation);
    } finally {
      unlinkIfOwned(recoveryOwner.path, recoveryOwner.identity);
    }
  }
  const capability = Object.freeze({});
  activeLifecycleCapabilities.add(capability);
  return {
    capability,
    release() {
      activeLifecycleCapabilities.delete(capability);
      try {
        const current = readJson(paths.lock, "lifecycle lock");
        if (current.token === token) unlinkSync(paths.lock);
      } catch {
        // Never remove a lock that no longer proves this operation owns it.
      }
    },
  };
}

export function assertLifecycleCapability(capability) {
  if (!capability || !activeLifecycleCapabilities.has(capability)) fail("Invalid managed lifecycle lock capability");
}

export function withLifecycleLock(dataRoot, operation, callback) {
  const acquired = acquireLifecycleLock(dataRoot, operation);
  try { return callback(acquired.capability); } finally { acquired.release(); }
}

export async function withLifecycleLockAsync(dataRoot, operation, callback) {
  const acquired = acquireLifecycleLock(dataRoot, operation);
  try { return await callback(acquired.capability); } finally { acquired.release(); }
}

function validateArtifactBytes(path, expected, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} artifact is not a regular file`);
  if (stat.size !== expected.size) fail(`${label} artifact size mismatch`);
  if (sha256File(path) !== expected.sha256) fail(`${label} artifact digest mismatch`);
}

function validateArtifact(path, expected, label) {
  exactObject(expected, `${label} artifact`, ["name", "sha256", "size"]);
  if (basename(path) !== expected.name) fail(`${label} artifact name mismatch`);
  validateArtifactBytes(path, expected, label);
}

function validateArchiveEntries(archivePath) {
  const names = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
  if (names.error || names.status !== 0) fail(`Cannot inspect archive ${basename(archivePath)}: ${(names.stderr || names.stdout).trim()}`);
  for (const raw of names.stdout.split("\n")) {
    if (!raw) continue;
    const path = raw.replace(/^\.\//, "").replace(/\/$/, "");
    if (!path) continue;
    if (path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      fail(`Archive contains unsafe path: ${raw}`);
    }
  }
  const verbose = spawnSync("tar", ["-tvzf", archivePath], { encoding: "utf8" });
  if (verbose.error || verbose.status !== 0) fail(`Cannot inspect archive ${basename(archivePath)}`);
  for (const line of verbose.stdout.split("\n")) {
    if (line && line[0] !== "-" && line[0] !== "d") fail(`Archive contains unsupported file kind: ${line}`);
  }
}

function createStage(paths, kind) {
  const token = randomUUID();
  const stage = join(paths.temporary, `${kind}.tmp-${token}`);
  mkdirSync(stage, { mode: 0o700 });
  writeFileSync(join(stage, ".owner.json"), serializeMetadata({
    schemaVersion: 1,
    type: "managed-temporary",
    ownedPath: stage,
    token,
  }), { flag: "wx", mode: 0o600 });
  const payload = join(stage, "payload");
  mkdirSync(payload, { mode: 0o700 });
  return { stage, payload, token };
}

function extractArchive(archivePath, destination) {
  validateArchiveEntries(archivePath);
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", destination, "--no-same-owner"], { encoding: "utf8" });
  if (result.error || result.status !== 0) fail(`Cannot extract ${basename(archivePath)}: ${(result.stderr || result.stdout).trim()}`);
  createPayloadInventory(destination); // Reject symlinks and unsupported file kinds after extraction too.
}

function makeWritable(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  } else chmodSync(path, 0o600);
}

function removeStage(stage) {
  if (!existsSync(stage)) return;
  makeWritable(stage);
  rmSync(stage, { recursive: true, force: true });
}

export async function withManagedTemporaryDirectory(dataRoot, kind, callback) {
  ensureIdentifier(kind, "managed temporary kind");
  const stage = createStage(initializeLayout(dataRoot), kind);
  try { return await callback(stage.payload); } finally { removeStage(stage.stage); }
}

function immutableTree(path) {
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) fail(`Immutable payload contains symbolic link: ${child}`);
    if (stat.isDirectory()) {
      immutableTree(child);
      chmodSync(child, 0o555);
    } // Signed payload file modes are preserved; the immutable directory boundary blocks replacement.
  }
  chmodSync(path, 0o555);
}

function runChecked(command, args, label, expected) {
  const result = spawnSync(command, args, { encoding: "utf8", env: process.env });
  if (result.error || result.status !== 0) fail(`${label} failed: ${(result.stderr || result.stdout).trim()}`);
  const output = result.stdout.trim();
  if (expected !== undefined && output !== expected) fail(`${label} mismatch: expected ${expected}, found ${output}`);
  return output;
}

function validateQuestionTool(root, manifest) {
  const questionRoot = join(root, "pi-wait-for-user", "question-tool");
  const extension = join(questionRoot, "extensions", "question-tool.ts");
  if (!lstatSync(extension).isFile()) fail("Question Tool extension is missing");
  const packageManifest = readJson(join(questionRoot, "package.json"), "Question Tool package manifest");
  const expected = manifest.compatibility.questionTool;
  if (packageManifest.name !== expected.name || packageManifest.version !== expected.version) fail("Question Tool package identity mismatch");
  const contract = packageManifest.piWaitForUser;
  if (!plainObject(contract)
    || canonicalJson(contract.coreProtocolVersions) !== canonicalJson(expected.coreProtocolVersions)
    || contract.handlerId !== expected.handlerId
    || contract.handlerVersion !== expected.handlerVersion
    || canonicalJson(contract.packageSchemaVersions) !== canonicalJson(expected.packageSchemaVersions)) {
    fail("Question Tool compatibility mismatch");
  }
}

function payloadWithoutManagerFiles(root) {
  return createPayloadInventory(root).filter((entry) => entry.path !== ".owner.json" && !entry.path.startsWith(".managed/"));
}

function comparePayload(actual, expected) {
  const found = [...actual].sort((a, b) => a.path.localeCompare(b.path));
  const declared = [...expected].sort((a, b) => a.path.localeCompare(b.path));
  if (canonicalJson(found.map(({ path }) => path)) !== canonicalJson(declared.map(({ path }) => path))) fail("Extracted payload inventory mismatch");
  for (let index = 0; index < declared.length; index += 1) {
    if (found[index].size !== declared[index].size) fail(`Payload size mismatch: ${declared[index].path}`);
    if (found[index].sha256 !== declared[index].sha256) fail(`Payload digest mismatch: ${declared[index].path}`);
    if (found[index].mode !== declared[index].mode) fail(`Payload mode mismatch: ${declared[index].path}`);
  }
}

function publishStableDispatcher(paths, selected) {
  if (selected.config.rootKeyProvenance.type !== rootKeyProvenanceType.installerPinned) {
    fail("Command Ownership requires root keys pinned by the reviewed installer");
  }
  const destination = join(paths.root, "dispatcher");
  const receiptPath = join(paths.state, "dispatcher.json");
  const source = join(selected.managerPath, "package", "scripts");
  const required = ["managed-dispatcher.mjs", "lib/managed-command.mjs", "lib/managed-runtime.mjs", "lib/release-metadata.mjs"];
  const pinnedRootConfiguration = serializeMetadata({
    schemaVersion: 1,
    rootKeys: [...selected.config.rootKeys]
      .map(([keyId, publicKey]) => ({ keyId, publicKey }))
      .sort((left, right) => left.keyId.localeCompare(right.keyId)),
  });
  const expectedPayload = required.map((relativePath) => {
    const sourcePath = ensureNoSymlinkPath(selected.managerPath, join(source, relativePath), "Manager Release Dispatcher source path");
    const declaredPath = relative(selected.managerPath, sourcePath).split(sep).join("/");
    const entry = selected.managerReceipt.payload.find((candidate) => candidate.path === declaredPath);
    if (!entry) fail(`Manager Release does not own Dispatcher source: ${relativePath}`);
    return { ...entry, path: relativePath, mode: relativePath === "managed-dispatcher.mjs" ? 0o755 : 0o444 };
  });
  expectedPayload.push({
    path: "managed-root-keys.json",
    sha256: digestBytes(pinnedRootConfiguration),
    size: Buffer.byteLength(pinnedRootConfiguration),
    mode: 0o444,
  });
  if (pathExists(destination)) {
    if (lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isDirectory()) fail("Managed Dispatcher path is foreign");
    const embeddedPath = join(destination, ".managed", "receipt.json");
    const receipt = readJson(embeddedPath, "Managed Dispatcher receipt");
    exactObject(receipt, "Managed Dispatcher receipt", [
      "schemaVersion", "type", "ownedPath", "managerReleaseId", "platform", "sourceArtifact", "createdAt", "payload",
    ]);
    if (receipt.schemaVersion !== 1 || receipt.type !== "managed-dispatcher" || resolve(receipt.ownedPath) !== destination
      || !Array.isArray(receipt.payload)) fail("Malformed Managed Dispatcher receipt");
    ensureIdentifier(receipt.managerReleaseId, "Dispatcher Manager Release ID");
    ensurePlatform(receipt.platform);
    exactObject(receipt.sourceArtifact, "Dispatcher source artifact", ["name", "sha256", "size"]);
    ensureRelativePath(receipt.sourceArtifact.name, "Dispatcher source artifact name");
    expectString(receipt.sourceArtifact.sha256, "Dispatcher source artifact digest", sha256Pattern);
    if (!Number.isSafeInteger(receipt.sourceArtifact.size) || receipt.sourceArtifact.size < 0) fail("Malformed Dispatcher source artifact");
    expectDate(receipt.createdAt, "Dispatcher creation date");
    receipt.payload.forEach((entry, index) => validatePayloadEntry(entry, `Managed Dispatcher receipt payload[${index}]`));
    const installedPayload = createPayloadInventory(destination).filter((entry) => !entry.path.startsWith(".managed/"));
    if (pathExists(receiptPath)) {
      const central = readJson(receiptPath, "Managed Dispatcher receipt");
      if (canonicalJson(central) !== canonicalJson(receipt)) fail("Managed Dispatcher receipt copies mismatch");
      comparePayload(installedPayload, receipt.payload);
    } else {
      if (receipt.managerReleaseId !== selected.pair.managerReleaseId || receipt.platform !== selected.pair.platform
        || canonicalJson(receipt.sourceArtifact) !== canonicalJson(selected.managerReceipt.sourceArtifact)) {
        fail("Unreceipted Managed Dispatcher does not match the verified Manager Release");
      }
      comparePayload(receipt.payload, expectedPayload);
      comparePayload(installedPayload, expectedPayload);
      atomicWrite(receiptPath, receipt);
    }
    return join(destination, "managed-dispatcher.mjs");
  }
  if (pathExists(receiptPath)) fail("Managed Dispatcher receipt exists without its owned payload");
  const stage = createStage(paths, "dispatcher");
  try {
    for (const relativePath of required) {
      const output = join(stage.payload, relativePath);
      mkdir(dirname(output));
      copyFileSync(join(source, relativePath), output);
      chmodSync(output, relativePath === "managed-dispatcher.mjs" ? 0o755 : 0o444);
    }
    writeFileSync(join(stage.payload, "managed-root-keys.json"), pinnedRootConfiguration, { flag: "wx", mode: 0o444 });
    const payload = createPayloadInventory(stage.payload);
    comparePayload(payload, expectedPayload);
    const receipt = {
      schemaVersion: 1,
      type: "managed-dispatcher",
      ownedPath: destination,
      managerReleaseId: selected.pair.managerReleaseId,
      platform: selected.pair.platform,
      sourceArtifact: selected.managerReceipt.sourceArtifact,
      createdAt: new Date().toISOString(),
      payload,
    };
    mkdir(join(stage.payload, ".managed"));
    writeFileSync(join(stage.payload, ".managed", "receipt.json"), serializeMetadata(receipt), { flag: "wx", mode: 0o600 });
    renameSync(stage.payload, destination);
    immutableTree(destination);
    removeStage(stage.stage);
    atomicWrite(receiptPath, receipt);
    return join(destination, "managed-dispatcher.mjs");
  } catch (error) {
    removeStage(stage.stage);
    throw error;
  }
}

function legacyPayloadInventory(legacyPath, expected) {
  if (!pathExists(legacyPath) || lstatSync(legacyPath).isSymbolicLink() || !lstatSync(legacyPath).isDirectory()) return null;
  if (!expected.every((entry) => entry.path.startsWith("pi-wait-for-user/"))) return null;
  let actual;
  try { actual = createPayloadInventory(legacyPath); } catch { return null; }
  const declared = expected.map((entry) => ({ ...entry, path: entry.path.slice("pi-wait-for-user/".length) }));
  try { comparePayload(actual, declared); } catch { return null; }
  return actual;
}

function adoptVerifiedLegacyPayload(stage, legacyPath, expected) {
  if (!legacyPayloadInventory(legacyPath, expected)) return false;
  const packagedPayload = join(stage.payload, "pi-wait-for-user");
  makeWritable(packagedPayload);
  rmSync(packagedPayload, { recursive: true, force: true });
  cpSync(legacyPath, packagedPayload, { recursive: true, dereference: false, preserveTimestamps: true });
  comparePayload(payloadWithoutManagerFiles(stage.payload), expected);
  return true;
}

function discoverLegacyPaths(paths, releaseId, explicitPaths = []) {
  if (!Array.isArray(explicitPaths) || explicitPaths.some((path) => typeof path !== "string" || !path)) {
    fail("Malformed Legacy Downstream Installation paths");
  }
  const legacyRoot = join(paths.root, "releases");
  const defaultPath = join(legacyRoot, releaseId);
  const discovered = [defaultPath, ...explicitPaths.map((path) => resolve(path))];
  if (pathExists(legacyRoot) && !lstatSync(legacyRoot).isSymbolicLink() && lstatSync(legacyRoot).isDirectory()) {
    discovered.push(...readdirSync(legacyRoot).sort().map((name) => join(legacyRoot, name)));
  }
  return discovered.filter((path, index) => pathExists(path) && discovered.indexOf(path) === index);
}

function updateLegacyInstallationAdoption(paths, { legacyPaths, legacyAdopted, legacyPath, releaseId }) {
  const adoptionPath = join(paths.state, "legacy-adoption.json");
  if (legacyPaths.length > 0) {
    const listedPaths = legacyPaths.join(", ");
    atomicWrite(adoptionPath, {
      schemaVersion: 1,
      type: "legacy-downstream-installation-adoption",
      releaseId,
      legacyPath,
      disposition: legacyAdopted ? "adopted-after-signed-verification" : "fresh-install-legacy-untouched",
      cleanup: `After confirming managed commands work, remove Legacy Downstream Installation directories manually if desired: ${listedPaths}`,
    });
  } else if (pathExists(adoptionPath)) unlinkSync(adoptionPath);
}

function pairFor(manifest, platform) {
  return {
    managerReleaseId: manifest.manager.releaseId,
    downstreamReleaseId: manifest.releaseId,
    manifestSha256: "",
    platform,
  };
}

function receiptPath(paths, type, id) {
  return join(paths.receipts, type === "manager" ? "managers" : "releases", `${id}.json`);
}

function createReceipt({ type, ownedPath, managerReleaseId, downstreamReleaseId, platform, manifestSha256, sourceArtifact, verifiedAt, payload }) {
  return {
    schemaVersion: 1,
    type,
    ownedPath,
    managerReleaseId,
    downstreamReleaseId,
    platform,
    manifestSha256,
    sourceArtifact,
    verifiedAt,
    payload,
  };
}

function validatePayloadEntry(entry, label) {
  exactObject(entry, label, ["path", "sha256", "size", "mode"]);
  ensureRelativePath(entry.path, `${label} path`);
  expectString(entry.sha256, `${label} digest`, sha256Pattern);
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) fail(`Malformed ${label}`);
}

function validateReceipt(value, type, expectedPath, pair) {
  exactObject(value, `${type} receipt`, receiptKeys);
  if (value.schemaVersion !== 1 || value.type !== type) fail(`Malformed ${type} receipt`);
  ensureIdentifier(value.managerReleaseId, "receipt Manager Release ID");
  if (value.downstreamReleaseId !== null) ensureIdentifier(value.downstreamReleaseId, "receipt Downstream Release ID");
  ensurePlatform(value.platform);
  expectString(value.manifestSha256, "receipt manifest digest", sha256Pattern);
  exactObject(value.sourceArtifact, "receipt source artifact", ["name", "sha256", "size"]);
  ensureRelativePath(value.sourceArtifact.name, "receipt source artifact name");
  expectString(value.sourceArtifact.sha256, "receipt source artifact digest", sha256Pattern);
  if (!Number.isSafeInteger(value.sourceArtifact.size) || value.sourceArtifact.size < 0) fail("Malformed receipt source artifact");
  expectDate(value.verifiedAt, "receipt verification date");
  if (!Array.isArray(value.payload)) fail(`Malformed ${type} receipt payload`);
  value.payload.forEach((entry, index) => validatePayloadEntry(entry, `${type} receipt payload[${index}]`));
  if (new Set(value.payload.map((entry) => entry.path)).size !== value.payload.length) fail(`Malformed ${type} receipt payload`);
  if (resolve(value.ownedPath) !== resolve(expectedPath)) fail(`${type} receipt owned path is foreign`);
  if (value.managerReleaseId !== pair.managerReleaseId || value.platform !== pair.platform) fail(`${type} receipt pair mismatch`);
  if (type === "downstream" && value.downstreamReleaseId !== pair.downstreamReleaseId) fail("Downstream receipt pair mismatch");
  return value;
}

function publishStage(stage, destination, receipt, paths, checkpoint, boundary) {
  const embedded = join(stage.payload, ".managed");
  mkdirSync(embedded, { recursive: true, mode: 0o700 });
  writeFileSync(join(embedded, "receipt.json"), serializeMetadata(receipt), { flag: "wx", mode: 0o600 });
  let publishedReceipt = receipt;
  if (existsSync(destination)) {
    const existingReceipt = readJson(join(destination, ".managed", "receipt.json"), `${receipt.type} receipt`);
    const pair = {
      managerReleaseId: receipt.managerReleaseId,
      downstreamReleaseId: receipt.downstreamReleaseId ?? receipt.managerReleaseId,
      platform: receipt.platform,
    };
    validateReceipt(existingReceipt, receipt.type, destination, pair);
    if ((receipt.type === "downstream" && existingReceipt.manifestSha256 !== receipt.manifestSha256)
      || canonicalJson(existingReceipt.sourceArtifact) !== canonicalJson(receipt.sourceArtifact)
      || canonicalJson(existingReceipt.payload) !== canonicalJson(receipt.payload)) {
      fail(`Immutable ${receipt.type} release identity already exists with different content`);
    }
    comparePayload(payloadWithoutManagerFiles(destination), existingReceipt.payload);
    publishedReceipt = existingReceipt;
    removeStage(stage.stage);
  } else {
    renameSync(stage.payload, destination);
    immutableTree(destination);
    removeStage(stage.stage);
  }
  const centralReceipt = receiptPath(
    paths,
    receipt.type,
    receipt.type === "manager" ? receipt.managerReleaseId : receipt.downstreamReleaseId,
  );
  ensureManagedDirectory(dirname(centralReceipt));
  atomicWrite(centralReceipt, publishedReceipt);
  checkpoint?.(boundary);
}

function readAcceptedMetadataState(paths) {
  if (!existsSync(paths.accepted)) return undefined;
  const accepted = readJson(paths.accepted, "accepted metadata state");
  exactObject(accepted, "accepted metadata state", ["schemaVersion", "trust", "channel"]);
  if (accepted.schemaVersion !== 1) fail("Malformed accepted metadata state");
  exactObject(accepted.trust, "accepted trust state", ["version", "envelopeSha256"]);
  exactObject(accepted.channel, "accepted Channel state", ["sequence", "releaseId", "manifestSha256", "envelopeSha256"]);
  return accepted;
}

function rootKeyProvenance(rootKeys, type) {
  const keys = [...rootKeys].map(([keyId, publicKey]) => ({ keyId, publicKey })).sort((a, b) => a.keyId.localeCompare(b.keyId));
  return { type, configurationSha256: digestBytes(serializeMetadata({ type, keys })) };
}

function writeConfig(paths, platform, rootKeys, provenanceType) {
  const config = {
    schemaVersion: 1,
    platform,
    rootKeys: [...rootKeys].map(([keyId, publicKey]) => ({ keyId, publicKey })).sort((a, b) => a.keyId.localeCompare(b.keyId)),
    rootKeyProvenance: rootKeyProvenance(rootKeys, provenanceType),
  };
  if (existsSync(paths.config)) {
    const existing = readConfig(paths);
    const configuredRootKeys = new Map(config.rootKeys.map(({ keyId, publicKey }) => [keyId, publicKey]));
    if (existing.platform !== platform || canonicalJson([...existing.rootKeys]) !== canonicalJson([...configuredRootKeys])) {
      fail("Managed root trust or platform configuration mismatch");
    }
    if (provenanceType === rootKeyProvenanceType.installerPinned && existing.rootKeyProvenance.type !== rootKeyProvenanceType.installerPinned) atomicWrite(paths.config, config);
  } else atomicWrite(paths.config, config);
}

function readConfig(paths) {
  const config = readJson(paths.config, "managed configuration");
  exactObject(config, "managed configuration", ["schemaVersion", "platform", "rootKeys", "rootKeyProvenance"]);
  if (config.schemaVersion !== 1 || !Array.isArray(config.rootKeys) || config.rootKeys.length === 0) fail("Malformed managed configuration");
  exactObject(config.rootKeyProvenance, "root-key provenance", ["type", "configurationSha256"]);
  if (!Object.values(rootKeyProvenanceType).includes(config.rootKeyProvenance.type)) fail("Malformed root-key provenance");
  expectString(config.rootKeyProvenance.configurationSha256, "root-key provenance digest", sha256Pattern);
  ensurePlatform(config.platform);
  const rootKeys = new Map();
  for (const entry of config.rootKeys) {
    exactObject(entry, "managed root key", ["keyId", "publicKey"]);
    expectString(entry.keyId, "managed root key ID");
    expectString(entry.publicKey, "managed root public key");
    if (rootKeys.has(entry.keyId)) fail("Malformed managed configuration");
    rootKeys.set(entry.keyId, entry.publicKey);
  }
  if (config.rootKeyProvenance.configurationSha256 !== rootKeyProvenance(rootKeys, config.rootKeyProvenance.type).configurationSha256) {
    fail("Root-key provenance configuration mismatch");
  }
  return { ...config, rootKeys };
}

function validatePairShape(value, label) {
  exactObject(value, label, ["managerReleaseId", "downstreamReleaseId", "manifestSha256", "platform"]);
  ensureIdentifier(value.managerReleaseId, `${label} Manager Release ID`);
  ensureIdentifier(value.downstreamReleaseId, `${label} Downstream Release ID`);
  expectString(value.manifestSha256, `${label} manifest digest`, sha256Pattern);
  ensurePlatform(value.platform);
  return value;
}

export function readActivation(dataRoot) {
  const paths = layout(dataRoot);
  ensureManagedDirectory(paths.root);
  ensureManagedDirectory(paths.state);
  const activation = readJson(paths.activation, "Activation");
  exactObject(activation, "Activation", ["schemaVersion", "type", "createdAt", "active", "previous"]);
  if (activation.schemaVersion !== 1 || activation.type !== "activation") fail("Malformed Activation");
  expectDate(activation.createdAt, "Activation creation date");
  validatePairShape(activation.active, "active Activation pair");
  if (activation.previous !== null) validatePairShape(activation.previous, "previous Activation pair");
  return activation;
}

function readReceiptCopies(paths, type, id, ownedPath, pair) {
  const centralPath = ensureNoSymlinkPath(paths.receipts, receiptPath(paths, type, id), `${type} receipt path`);
  const embeddedPath = ensureNoSymlinkPath(ownedPath, join(ownedPath, ".managed", "receipt.json"), `${type} embedded receipt path`);
  const central = validateReceipt(readJson(centralPath, `${type} receipt`), type, ownedPath, pair);
  const embedded = validateReceipt(readJson(embeddedPath, `${type} receipt`), type, ownedPath, pair);
  if (canonicalJson(central) !== canonicalJson(embedded)) fail(`${type} receipt copies mismatch`);
  return central;
}

export function validateActivePair(dataRoot, pair = readActivation(dataRoot).active) {
  const paths = layout(dataRoot);
  for (const path of [paths.root, paths.state, paths.managers, paths.releases, paths.receipts]) ensureManagedDirectory(path);
  const config = readConfig(paths);
  validatePairShape(pair, "Activation pair");
  if (pair.platform !== config.platform) fail("Activation platform mismatch");
  const managerPath = ensureNoSymlinkPath(paths.managers, join(paths.managers, pair.managerReleaseId), "Manager Release path");
  const releasePath = ensureNoSymlinkPath(paths.releases, join(paths.releases, pair.downstreamReleaseId), "Downstream Release path");
  if (!lstatSync(managerPath).isDirectory() || !lstatSync(releasePath).isDirectory()) fail("Activation payload directory is missing");
  const managerReceipt = readReceiptCopies(paths, "manager", pair.managerReleaseId, managerPath, pair);
  const releaseReceipt = readReceiptCopies(paths, "downstream", pair.downstreamReleaseId, releasePath, pair);
  if (releaseReceipt.manifestSha256 !== pair.manifestSha256) fail("Activation manifest identity mismatch");
  const managerExecutable = ensureNoSymlinkPath(managerPath, join(managerPath, "package", "manager"), "Manager Release executable path");
  const pi = ensureNoSymlinkPath(releasePath, join(releasePath, "pi-wait-for-user", "pi-core"), "Pi executable path");
  const question = ensureNoSymlinkPath(
    releasePath,
    join(releasePath, "pi-wait-for-user", "question-tool", "extensions", "question-tool.ts"),
    "Question Tool path",
  );
  const releaseMetadata = ensureNoSymlinkPath(
    releasePath,
    join(releasePath, "pi-wait-for-user", "release.json"),
    "Downstream Release metadata path",
  );
  const manifest = ensureNoSymlinkPath(releasePath, join(releasePath, ".managed", "release-manifest.json"), "Release Manifest path");
  for (const [path, label, executable] of [
    [managerExecutable, "Manager Release executable", true],
    [pi, "Pi executable", true],
    [question, "Question Tool", false],
    [releaseMetadata, "Downstream Release metadata", false],
    [manifest, "Release Manifest", false],
  ]) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} is missing or foreign`);
    if (executable && (stat.mode & 0o111) === 0) fail(`${label} is not executable`);
  }
  const projectedRelease = readJson(releaseMetadata, "Downstream Release metadata");
  if (projectedRelease.schemaVersion !== 1 || projectedRelease.releaseId !== pair.downstreamReleaseId
    || projectedRelease.platform !== pair.platform) fail("Downstream Release metadata pair mismatch");
  if (sha256File(manifest) !== pair.manifestSha256) fail("Release Manifest digest mismatch");
  return { paths, config, pair, managerPath, releasePath, managerExecutable, pi, managerReceipt, releaseReceipt };
}

function verifyPayloadAgainstArtifact(installedPath, artifactPath, label) {
  const temporary = mkdtempSync(join(tmpdir(), "pi-managed-artifact-verification-"));
  const payload = join(temporary, "payload");
  mkdirSync(payload, { mode: 0o700 });
  try {
    extractArchive(artifactPath, payload);
    comparePayload(payloadWithoutManagerFiles(installedPath), payloadWithoutManagerFiles(payload));
  } catch (error) {
    fail(`${label} payload verification failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    removeStage(temporary);
  }
}

function verifyPair(dataRoot, pair, { provenance = false, gh = "gh" } = {}) {
  const selected = validateActivePair(dataRoot, pair);
  const metadataRoot = join(selected.releasePath, ".managed");
  const trustEnvelope = readJson(join(metadataRoot, "release-trust.json"), "release trust metadata");
  const channelEnvelope = readJson(join(metadataRoot, "release-channel.json"), "Release Channel");
  const manifestEnvelope = readJson(join(metadataRoot, "release-manifest.json"), "Release Manifest");
  const verificationTime = new Date(selected.releaseReceipt.verifiedAt);
  const authority = verifyTrustMetadata(trustEnvelope, { trustedRootKeys: selected.config.rootKeys, now: verificationTime });
  verifyChannel(channelEnvelope, { trust: authority, now: verificationTime, manifest: manifestEnvelope });
  const manifest = verifyReleaseManifest(manifestEnvelope, { trust: authority, now: verificationTime });
  if (manifest.releaseId !== pair.downstreamReleaseId || manifest.manager.releaseId !== pair.managerReleaseId) fail("Release Manifest pair mismatch");
  if (!manifest.manager.compatibleReleaseManifestVersions.includes(manifestEnvelope.signed.schemaVersion)) fail("Manager Release compatibility mismatch");
  const managerArtifact = manifest.manager.artifacts.find((entry) => canonicalJson(entry) === canonicalJson(selected.managerReceipt.sourceArtifact));
  if (!managerArtifact) fail("Manager Release artifact identity mismatch");
  const downstream = manifest.platformArchives.find((entry) => entry.platform === pair.platform);
  if (!downstream || canonicalJson(downstream.artifact) !== canonicalJson(selected.releaseReceipt.sourceArtifact)) fail("Downstream Release artifact identity mismatch");
  ensureManagedDirectory(selected.paths.artifacts);
  const cachedManagerArtifact = ensureNoSymlinkPath(
    selected.paths.artifacts,
    join(selected.paths.artifacts, managerArtifact.sha256),
    "Cached Manager Release path",
  );
  const cachedDownstreamArtifact = ensureNoSymlinkPath(
    selected.paths.artifacts,
    join(selected.paths.artifacts, downstream.artifact.sha256),
    "Cached Downstream Release path",
  );
  validateArtifactBytes(cachedManagerArtifact, managerArtifact, "Cached Manager Release");
  validateArtifactBytes(cachedDownstreamArtifact, downstream.artifact, "Cached Downstream Release");
  verifyPayloadAgainstArtifact(selected.managerPath, cachedManagerArtifact, "Manager Release");
  comparePayload(payloadWithoutManagerFiles(selected.managerPath), selected.managerReceipt.payload);
  comparePayload(payloadWithoutManagerFiles(selected.releasePath), downstream.payload);
  runChecked(selected.managerExecutable, ["--manager-version"], "Manager reported version", pair.managerReleaseId);
  runChecked(selected.pi, ["--version"], "Pi reported version", manifest.upstream.packageVersion);
  runChecked(selected.pi, ["--help"], "Pi smoke check");
  const conformance = runChecked(selected.pi, ["conformance"], "Pi conformance");
  if (!/conformance passed/i.test(conformance)) fail("Pi conformance did not report success");
  validateQuestionTool(selected.releasePath, manifest);
  if (provenance) verifyInstalledProvenance(selected, manifest, gh);
  return pair;
}

function verifyInstalledProvenance(selected, manifest, gh) {
  for (const receipt of [selected.managerReceipt, selected.releaseReceipt]) {
    const artifactPath = join(selected.paths.artifacts, receipt.sourceArtifact.sha256);
    validateArtifactBytes(artifactPath, receipt.sourceArtifact, "Cached provenance");
    const result = spawnSync(gh, [
      "attestation", "verify", artifactPath,
      "--repo", manifest.provenance.repository,
      "--signer-workflow", `${manifest.provenance.repository}/${manifest.provenance.workflow}`,
      "--source-digest", manifest.provenance.sourceCommit,
      "--deny-self-hosted-runners",
    ], { encoding: "utf8" });
    if (result.error || result.status !== 0) fail(`Provenance verification failed for ${receipt.sourceArtifact.name}: ${(result.stderr || result.stdout).trim()}`);
  }
}

export function verifyManagedInstallation(dataRoot, options = {}) {
  const activation = readActivation(dataRoot);
  const pairs = options.all && activation.previous
    ? [activation.active, activation.previous]
    : [activation.active];
  const unique = pairs.filter((pair, index) => pairs.findIndex((entry) => canonicalJson(entry) === canonicalJson(pair)) === index);
  return unique.map((pair) => verifyPair(dataRoot, pair, options));
}

function saveArtifact(paths, source, expected) {
  const destination = join(paths.artifacts, expected.sha256);
  if (existsSync(destination)) {
    validateArtifactBytes(destination, expected, "Cached artifact");
    return destination;
  }
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    copyFileSync(source, temporary);
    validateArtifactBytes(temporary, expected, "Copied artifact");
    chmodSync(temporary, 0o444);
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return destination;
}

function isManagedDiagnostic(paths, name) {
  if (!/^\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(name)) return false;
  try {
    const path = join(paths.diagnostics, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_048) return false;
    const value = readJson(path, "managed diagnostic");
    exactObject(value, "managed diagnostic", ["schemaVersion", "type", "stage", "recordedAt", "error"]);
    if (value.schemaVersion !== 1 || !["activation-failure", "managed-update-failure"].includes(value.type)) return false;
    expectString(value.stage, "managed diagnostic stage");
    expectDate(value.recordedAt, "managed diagnostic date");
    return typeof value.error === "string" && value.error.length <= 500;
  } catch {
    return false;
  }
}

function writeManagedDiagnostic(paths, type, stage, error) {
  try {
    atomicWrite(join(paths.diagnostics, `${Date.now()}-${randomUUID()}.json`), {
      schemaVersion: 1,
      type,
      stage,
      recordedAt: new Date().toISOString(),
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    const diagnostics = readdirSync(paths.diagnostics).filter((name) => isManagedDiagnostic(paths, name)).sort();
    for (const name of diagnostics.slice(0, Math.max(0, diagnostics.length - managedDiagnosticLimit))) {
      unlinkSync(join(paths.diagnostics, name));
    }
  } catch {
    // A diagnostic must never mask the original verification failure.
  }
}

function diagnostic(paths, error) {
  writeManagedDiagnostic(paths, "activation-failure", "verification-and-activation", error);
}

export function recordManagedUpdateDiagnostic(dataRoot, stage, error) {
  expectString(stage, "Managed Update diagnostic stage");
  writeManagedDiagnostic(initializeLayout(dataRoot), "managed-update-failure", stage, error);
}

function installAndActivateWithProvenance(options, provenanceType) {
  const {
    dataRoot,
    platform,
    trustEnvelope,
    channelEnvelope,
    manifestEnvelope,
    rootKeys,
    managerArchive,
    releaseArchive,
    now = new Date(),
    checkpoint,
    legacyDirectories = [],
    lifecycleCapability,
  } = options;
  ensurePlatform(platform);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("Invalid activation verification date");
  if (!(rootKeys instanceof Map) || rootKeys.size === 0) fail("No pinned root keys configured");
  const activate = () => {
    const paths = initializeLayout(dataRoot);
    let managerStage;
    let releaseStage;
    try {
      writeConfig(paths, platform, rootKeys, provenanceType);
      const accepted = readAcceptedMetadataState(paths);
      if (!accepted && pathExists(paths.activation)) fail("Accepted metadata state is missing for existing Activation");
      const authority = verifyTrustMetadata(trustEnvelope, {
        trustedRootKeys: rootKeys,
        now,
        accepted: accepted?.trust,
      });
      const selection = verifyChannel(channelEnvelope, {
        trust: authority,
        now,
        manifest: manifestEnvelope,
        accepted: accepted?.channel,
      });
      const manifest = verifyReleaseManifest(manifestEnvelope, { trust: authority, now });
      const pair = pairFor(manifest, platform);
      pair.manifestSha256 = metadataDigest(manifestEnvelope);
      const managerArtifact = manifest.manager.artifacts.find((entry) => entry.name === basename(managerArchive));
      if (!managerArtifact) fail("Manager Release artifact is not declared by the Release Manifest");
      const downstream = manifest.platformArchives.find((entry) => entry.platform === platform);
      if (!downstream) fail(`Platform is not declared by Release Manifest: ${platform}`);
      validateArtifact(managerArchive, managerArtifact, "Manager Release");
      validateArtifact(releaseArchive, downstream.artifact, "Downstream Release");
      const cachedManagerArchive = saveArtifact(paths, managerArchive, managerArtifact);
      const cachedReleaseArchive = saveArtifact(paths, releaseArchive, downstream.artifact);

      managerStage = createStage(paths, "manager");
      extractArchive(cachedManagerArchive, managerStage.payload);
      const managerExecutable = join(managerStage.payload, "package", "manager");
      if (!existsSync(managerExecutable) || (lstatSync(managerExecutable).mode & 0o111) === 0) fail("Manager Release executable is missing");
      const managerPackage = readJson(join(managerStage.payload, "package", "package.json"), "Manager Release package manifest");
      if (managerPackage.piWaitForUser?.managerReleaseId !== manifest.manager.releaseId
        || !Array.isArray(managerPackage.piWaitForUser.compatibleReleaseManifestVersions)
        || !managerPackage.piWaitForUser.compatibleReleaseManifestVersions.includes(manifestEnvelope.signed.schemaVersion)) {
        fail("Manager Release compatibility mismatch");
      }
      runChecked(managerExecutable, ["--manager-version"], "Manager reported version", manifest.manager.releaseId);
      checkpoint?.("manager-staged");

      releaseStage = createStage(paths, "downstream");
      extractArchive(cachedReleaseArchive, releaseStage.payload);
      comparePayload(payloadWithoutManagerFiles(releaseStage.payload), downstream.payload);
      validateQuestionTool(releaseStage.payload, manifest);
      const core = join(releaseStage.payload, "pi-wait-for-user", "pi-core");
      runChecked(core, ["--version"], "Pi reported version", manifest.upstream.packageVersion);
      runChecked(core, ["--help"], "Pi smoke check");
      const conformance = runChecked(core, ["conformance"], "Pi conformance");
      if (!/conformance passed/i.test(conformance)) fail("Pi conformance did not report success");
      const legacyPaths = discoverLegacyPaths(paths, manifest.releaseId, legacyDirectories);
      const verifiedLegacyPath = legacyPaths.find((path) => legacyPayloadInventory(path, downstream.payload));
      const legacyAdopted = Boolean(verifiedLegacyPath)
        && adoptVerifiedLegacyPayload(releaseStage, verifiedLegacyPath, downstream.payload);
      const legacyPath = legacyAdopted ? verifiedLegacyPath : legacyPaths[0];
      checkpoint?.("downstream-staged");

      atomicWrite(paths.accepted, { schemaVersion: 1, trust: authority.acceptedState, channel: selection });
      checkpoint?.("metadata-accepted");

      const verifiedAt = now.toISOString();
      const managerDestination = join(paths.managers, manifest.manager.releaseId);
      const managerReceipt = createReceipt({
        type: "manager",
        ownedPath: managerDestination,
        managerReleaseId: manifest.manager.releaseId,
        downstreamReleaseId: null,
        platform,
        manifestSha256: pair.manifestSha256,
        sourceArtifact: managerArtifact,
        verifiedAt,
        payload: payloadWithoutManagerFiles(managerStage.payload),
      });
      publishStage(managerStage, managerDestination, managerReceipt, paths, checkpoint, "manager-published");
      managerStage = undefined;

      const releaseDestination = join(paths.releases, manifest.releaseId);
      const metadataDirectory = join(releaseStage.payload, ".managed");
      mkdirSync(metadataDirectory, { mode: 0o700 });
      writeFileSync(join(metadataDirectory, "release-trust.json"), serializeMetadata(trustEnvelope), { flag: "wx" });
      writeFileSync(join(metadataDirectory, "release-channel.json"), serializeMetadata(channelEnvelope), { flag: "wx" });
      writeFileSync(join(metadataDirectory, "release-manifest.json"), serializeMetadata(manifestEnvelope), { flag: "wx" });
      const releaseReceipt = createReceipt({
        type: "downstream",
        ownedPath: releaseDestination,
        managerReleaseId: manifest.manager.releaseId,
        downstreamReleaseId: manifest.releaseId,
        platform,
        manifestSha256: pair.manifestSha256,
        sourceArtifact: downstream.artifact,
        verifiedAt,
        payload: downstream.payload,
      });
      publishStage(releaseStage, releaseDestination, releaseReceipt, paths, checkpoint, "downstream-published");
      releaseStage = undefined;

      checkpoint?.("before-activation-switch");
      let previous = null;
      if (existsSync(paths.activation)) {
        const current = readActivation(dataRoot);
        if (canonicalJson(current.active) === canonicalJson(pair)) {
          updateLegacyInstallationAdoption(paths, { legacyPaths, legacyAdopted, legacyPath, releaseId: manifest.releaseId });
          return current;
        }
        previous = current.active;
      }
      const activation = {
        schemaVersion: 1,
        type: "activation",
        createdAt: new Date().toISOString(),
        active: pair,
        previous,
      };
      atomicWrite(paths.activation, activation);
      updateLegacyInstallationAdoption(paths, { legacyPaths, legacyAdopted, legacyPath, releaseId: manifest.releaseId });
      checkpoint?.("after-activation-switch");
      return activation;
    } catch (error) {
      if (managerStage) removeStage(managerStage.stage);
      if (releaseStage) removeStage(releaseStage.stage);
      diagnostic(paths, error);
      throw error;
    }
  };
  if (lifecycleCapability !== undefined) {
    assertLifecycleCapability(lifecycleCapability);
    return activate();
  }
  return withLifecycleLock(dataRoot, `activate ${manifestEnvelope?.signed?.releaseId ?? "candidate"}`, activate);
}

export function readManagedStartupContext(dataRoot) {
  const selected = validateActivePair(dataRoot);
  const accepted = readAcceptedMetadataState(selected.paths);
  if (!accepted) fail("Accepted metadata state is missing for existing Activation");
  return {
    active: {
      releaseId: selected.pair.downstreamReleaseId,
      managerReleaseId: selected.pair.managerReleaseId,
      manifestSha256: selected.pair.manifestSha256,
    },
    accepted,
  };
}

export function readManagedUpdateContext(dataRoot) {
  const selected = validateActivePair(dataRoot);
  if (selected.config.rootKeyProvenance.type !== rootKeyProvenanceType.installerPinned) {
    fail("Managed Update requires root keys pinned by the reviewed installer");
  }
  const metadataRoot = join(selected.releasePath, ".managed");
  const trustEnvelope = readJson(join(metadataRoot, "release-trust.json"), "release trust metadata");
  const channelEnvelope = readJson(join(metadataRoot, "release-channel.json"), "Release Channel");
  const manifestEnvelope = readJson(join(metadataRoot, "release-manifest.json"), "Release Manifest");
  const verificationTime = new Date(selected.releaseReceipt.verifiedAt);
  const authority = verifyTrustMetadata(trustEnvelope, { trustedRootKeys: selected.config.rootKeys, now: verificationTime });
  verifyChannel(channelEnvelope, { trust: authority, now: verificationTime, manifest: manifestEnvelope });
  const manifest = verifyReleaseManifest(manifestEnvelope, { trust: authority, now: verificationTime });
  if (manifest.releaseId !== selected.pair.downstreamReleaseId || manifest.manager.releaseId !== selected.pair.managerReleaseId) {
    fail("Release Manifest pair mismatch");
  }
  const accepted = readAcceptedMetadataState(selected.paths);
  if (!accepted) fail("Accepted metadata state is missing for existing Activation");
  return {
    active: {
      releaseId: manifest.releaseId,
      managerReleaseId: manifest.manager.releaseId,
      upstreamVersion: manifest.upstream.packageVersion,
      platform: selected.pair.platform,
      manifestSha256: selected.pair.manifestSha256,
      compatibility: manifest.compatibility,
    },
    accepted,
    rootKeys: selected.config.rootKeys,
    trustEnvelope,
    channelEnvelope,
    manifestEnvelope,
  };
}

export function acceptManagedUpdateMetadata(dataRoot, metadata, options = {}) {
  const accept = () => {
    const selected = validateActivePair(dataRoot);
    if (selected.config.rootKeyProvenance.type !== rootKeyProvenanceType.installerPinned) {
      fail("Managed Update requires root keys pinned by the reviewed installer");
    }
    const accepted = readAcceptedMetadataState(selected.paths);
    if (!accepted) fail("Accepted metadata state is missing for existing Activation");
    const authority = verifyTrustMetadata(metadata.trustEnvelope, {
      trustedRootKeys: selected.config.rootKeys,
      now: options.now || new Date(),
      accepted: accepted.trust,
    });
    const channel = verifyChannel(metadata.channelEnvelope, {
      trust: authority,
      now: options.now || new Date(),
      manifest: metadata.manifestEnvelope,
      accepted: accepted.channel,
    });
    atomicWrite(selected.paths.accepted, { schemaVersion: 1, trust: authority.acceptedState, channel });
    return { trust: authority.acceptedState, channel };
  };
  if (options.lifecycleCapability !== undefined) {
    assertLifecycleCapability(options.lifecycleCapability);
    return accept();
  }
  return withLifecycleLock(dataRoot, "accept Managed Update metadata", accept);
}

export function installAndActivate(options) {
  return installAndActivateWithProvenance(options, rootKeyProvenanceType.callerSelected);
}

export function installAndActivateFromManagedConfig(options) {
  const config = readConfig(layout(options.dataRoot));
  if (config.rootKeyProvenance.type !== rootKeyProvenanceType.installerPinned) {
    fail("Managed Update requires root keys pinned by the reviewed installer");
  }
  return installAndActivateWithProvenance({ ...options, platform: config.platform, rootKeys: config.rootKeys }, rootKeyProvenanceType.installerPinned);
}

export function installAndActivateFromPinnedRoot(options) {
  const configurationPath = join(dirname(dirname(fileURLToPath(import.meta.url))), "managed-root-keys.json");
  const rootKeys = readPinnedRootKeys(configurationPath);
  return installAndActivateWithProvenance({ ...options, rootKeys }, rootKeyProvenanceType.installerPinned);
}

export function recoverPrevious(dataRoot) {
  return withLifecycleLock(dataRoot, "recover previous Activation", () => {
    const paths = layout(dataRoot);
    const current = readActivation(dataRoot);
    if (!current.previous) fail("Activation has no retained previous pair");
    verifyPair(dataRoot, current.previous);
    const recovered = {
      schemaVersion: 1,
      type: "activation",
      createdAt: new Date().toISOString(),
      active: current.previous,
      previous: current.active,
    };
    atomicWrite(paths.activation, recovered);
    return recovered;
  });
}

function pairLeaseDirectory(paths, pair) {
  return join(paths.leases, `${pair.managerReleaseId}--${pair.downstreamReleaseId}`);
}

function livePairLeases(paths, pair) {
  const directory = pairLeaseDirectory(paths, pair);
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) return [directory];
  const live = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (lstatSync(path).isSymbolicLink()) {
      live.push(path); // Ambiguous lease state must defer deletion.
      continue;
    }
    let lease;
    try {
      lease = readJson(path, "pair lease");
      exactObject(lease, "pair lease", ["schemaVersion", "pid", "processStartIdentity", "token", "createdAt"]);
      if (lease.schemaVersion !== 1 || !Number.isSafeInteger(lease.pid) || lease.pid < 1
        || (lease.processStartIdentity !== null && (typeof lease.processStartIdentity !== "string" || !lease.processStartIdentity))) {
        fail("Malformed pair lease");
      }
      expectString(lease.token, "pair lease token");
      expectDate(lease.createdAt, "pair lease creation date");
    } catch {
      live.push(path); // Ambiguous lease state must defer deletion.
      continue;
    }
    const observedIdentity = managedProcessStartIdentity(lease.pid);
    if (observedIdentity === null || observedIdentity === lease.processStartIdentity) live.push(path);
    else unlinkSync(path);
  }
  return live;
}

export function acquirePairLease(dataRoot, pair) {
  const paths = initializeLayout(dataRoot);
  validatePairShape(pair, "leased pair");
  const directory = pairLeaseDirectory(paths, pair);
  ensureManagedDirectory(directory);
  const token = randomUUID();
  const path = join(directory, `${token}.json`);
  const lease = {
    schemaVersion: 1,
    pid: process.pid,
    processStartIdentity: currentManagedProcessStartIdentity(),
    token,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path, serializeMetadata(lease), { flag: "wx", mode: 0o600 });
  return {
    transfer(pid) {
      if (!Number.isSafeInteger(pid) || pid < 1) fail("Invalid pair lease process");
      atomicWrite(path, { ...lease, pid, processStartIdentity: managedProcessStartIdentity(pid) });
    },
    release() {
      try {
        const current = readJson(path, "pair lease");
        if (current.token === token) unlinkSync(path);
      } catch {
        // Never remove a lease that no longer belongs to this dispatcher.
      }
    },
  };
}

export async function dispatchActivePair(dataRoot, args, { environment = process.env } = {}) {
  const pair = readActivation(dataRoot).active;
  const lease = acquirePairLease(dataRoot, pair);
  let selected;
  try {
    selected = validateActivePair(dataRoot, pair);
  } catch (error) {
    lease.release();
    throw error;
  }
  const child = spawn(selected.managerExecutable, args, {
    stdio: "inherit",
    env: {
      ...environment,
      PI_MANAGED_DATA_ROOT: selected.paths.root,
      PI_MANAGED_MANAGER_DIR: selected.managerPath,
      PI_MANAGED_RELEASE_DIR: selected.releasePath,
      PI_MANAGED_MANAGER_RELEASE_ID: selected.pair.managerReleaseId,
      PI_MANAGED_DOWNSTREAM_RELEASE_ID: selected.pair.downstreamReleaseId,
    },
  });
  if (!child.pid) {
    lease.release();
    fail("Manager Release process could not be started");
  }
  lease.transfer(child.pid);
  const hold = Number(environment.PI_MANAGED_LEASE_HOLD_MS ?? 0);
  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  if (hold > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, hold));
  lease.release();
  return result.code ?? (result.signal ? 128 : 1);
}

function safeTemporaryOwner(path) {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) return false;
  const ownerPath = join(path, ".owner.json");
  if (!existsSync(ownerPath) || lstatSync(ownerPath).isSymbolicLink()) return false;
  try {
    const owner = readJson(ownerPath, "temporary receipt");
    exactObject(owner, "temporary receipt", ["schemaVersion", "type", "ownedPath", "token"]);
    return owner.schemaVersion === 1 && owner.type === "managed-temporary" && resolve(owner.ownedPath) === resolve(path)
      && basename(path).endsWith(owner.token);
  } catch {
    return false;
  }
}

function readPendingPairs(paths) {
  if (!existsSync(paths.pending)) return [];
  const pending = readJson(paths.pending, "pending cleanup state");
  exactObject(pending, "pending cleanup state", ["schemaVersion", "pairs"]);
  if (pending.schemaVersion !== 1 || !Array.isArray(pending.pairs)) fail("Malformed pending cleanup state");
  pending.pairs.forEach((pair) => validatePairShape(pair, "pending cleanup pair"));
  return pending.pairs;
}

function writePendingPairs(paths, pairs) {
  const unique = pairs.filter((pair, index) => pairs.findIndex((entry) => canonicalJson(entry) === canonicalJson(pair)) === index);
  if (unique.length === 0) {
    if (existsSync(paths.pending)) unlinkSync(paths.pending);
  } else atomicWrite(paths.pending, { schemaVersion: 1, pairs: unique });
}

export function cleanupManagedState(dataRoot) {
  const paths = initializeLayout(dataRoot);
  let removed = withLifecycleLock(dataRoot, "cleanup managed temporary state", () => {
    let temporaryRemoved = 0;
    for (const name of readdirSync(paths.temporary)) {
      const path = ensureInside(paths.temporary, join(paths.temporary, name), "Temporary cleanup path");
      if (!safeTemporaryOwner(path)) continue;
      removeStage(path);
      temporaryRemoved += 1;
    }
    return temporaryRemoved;
  });
  for (const pair of readPendingPairs(paths)) {
    try {
      if (removeInstalledPair(dataRoot, pair) === "removed") removed += 1;
    } catch (error) {
      if (!(error instanceof Error) || !/^Cannot remove (?:the active|the retained previous) pair$/.test(error.message)) throw error;
      // A pair selected since deferral remains pending for a later lifecycle pass.
    }
  }
  return removed;
}

function removeThroughTombstone(paths, source, kind) {
  const token = randomUUID();
  const tombstone = join(paths.temporary, `${kind}.tombstone-${token}`);
  mkdirSync(tombstone, { mode: 0o700 });
  writeFileSync(join(tombstone, ".owner.json"), serializeMetadata({
    schemaVersion: 1,
    type: "managed-temporary",
    ownedPath: tombstone,
    token,
  }), { flag: "wx", mode: 0o600 });
  chmodSync(source, 0o700);
  renameSync(source, join(tombstone, "payload"));
  removeStage(tombstone);
}

export function removeInstalledPair(dataRoot, pair) {
  return withLifecycleLock(dataRoot, `remove ${pair.downstreamReleaseId}`, () => {
    exactObject(pair, "cleanup pair", ["managerReleaseId", "downstreamReleaseId", "manifestSha256", "platform"]);
    validatePairShape(pair, "cleanup pair");
    const paths = layout(dataRoot);
    const activation = readActivation(dataRoot);
    if (canonicalJson(pair) === canonicalJson(activation.active)) fail("Cannot remove the active pair");
    if (activation.previous && canonicalJson(pair) === canonicalJson(activation.previous)) fail("Cannot remove the retained previous pair");
    if (livePairLeases(paths, pair).length > 0) {
      writePendingPairs(paths, [...readPendingPairs(paths), pair]);
      return "deferred";
    }
    const releasePath = join(paths.releases, pair.downstreamReleaseId);
    const centralReleaseReceipt = ensureNoSymlinkPath(
      paths.receipts,
      receiptPath(paths, "downstream", pair.downstreamReleaseId),
      "Downstream cleanup receipt path",
    );
    if (existsSync(releasePath)) {
      readReceiptCopies(paths, "downstream", pair.downstreamReleaseId, releasePath, pair);
      removeThroughTombstone(paths, releasePath, "downstream");
      unlinkSync(centralReleaseReceipt);
    } else if (existsSync(centralReleaseReceipt)) {
      validateReceipt(readJson(centralReleaseReceipt, "downstream receipt"), "downstream", releasePath, pair);
      unlinkSync(centralReleaseReceipt);
    }

    const retainedManager = [activation.active, activation.previous]
      .filter(Boolean)
      .some((entry) => entry.managerReleaseId === pair.managerReleaseId);
    const releaseReceipts = ensureNoSymlinkPath(paths.receipts, join(paths.receipts, "releases"), "Downstream receipt directory");
    const installedManagerReference = existsSync(releaseReceipts) && readdirSync(releaseReceipts).some((name) => {
      const path = ensureNoSymlinkPath(releaseReceipts, join(releaseReceipts, name), "Installed Downstream receipt path");
      const receipt = readJson(path, "downstream receipt");
      return receipt.managerReleaseId === pair.managerReleaseId;
    });
    const managerPath = join(paths.managers, pair.managerReleaseId);
    const centralManagerReceipt = ensureNoSymlinkPath(
      paths.receipts,
      receiptPath(paths, "manager", pair.managerReleaseId),
      "Manager cleanup receipt path",
    );
    if (!retainedManager && !installedManagerReference) {
      if (existsSync(managerPath)) {
        readReceiptCopies(paths, "manager", pair.managerReleaseId, managerPath, pair);
        removeThroughTombstone(paths, managerPath, "manager");
        unlinkSync(centralManagerReceipt);
      } else if (existsSync(centralManagerReceipt)) {
        validateReceipt(readJson(centralManagerReceipt, "manager receipt"), "manager", managerPath, pair);
        unlinkSync(centralManagerReceipt);
      }
    }
    writePendingPairs(paths, readPendingPairs(paths).filter((entry) => canonicalJson(entry) !== canonicalJson(pair)));
    return "removed";
  });
}

const ownershipKeys = [
  "schemaVersion", "type", "binDirectory", "dispatcher", "entrypoints", "stock", "createdFrom", "createdAt",
];
const stockKeys = ["resolvedPath", "executablePath", "sha256", "size", "version"];

function validateEntrypoint(value, label) {
  exactObject(value, label, ["path", "target"]);
  expectString(value.path, `${label} path`);
  expectString(value.target, `${label} target`);
  return value;
}

function validateStockIdentity(value) {
  if (value === null) return null;
  exactObject(value, "Stock Pi identity", stockKeys);
  expectString(value.resolvedPath, "Stock Pi resolved path");
  expectString(value.executablePath, "Stock Pi executable path");
  expectString(value.sha256, "Stock Pi digest", sha256Pattern);
  if (!Number.isSafeInteger(value.size) || value.size < 0) fail("Malformed Stock Pi identity");
  expectString(value.version, "Stock Pi version");
  return value;
}

export function readLegacyInstallationAdoption(dataRoot) {
  const adoptionPath = join(layout(dataRoot).state, "legacy-adoption.json");
  if (!pathExists(adoptionPath)) return null;
  const adoption = readJson(adoptionPath, "Legacy Downstream Installation adoption state");
  exactObject(adoption, "Legacy Downstream Installation adoption state", ["schemaVersion", "type", "releaseId", "legacyPath", "disposition", "cleanup"]);
  if (adoption.schemaVersion !== 1 || adoption.type !== "legacy-downstream-installation-adoption") {
    fail("Malformed Legacy Downstream Installation adoption state");
  }
  ensureIdentifier(adoption.releaseId, "Legacy Downstream Installation release ID");
  expectString(adoption.legacyPath, "Legacy Downstream Installation path");
  if (!["adopted-after-signed-verification", "fresh-install-legacy-untouched"].includes(adoption.disposition)) {
    fail("Malformed Legacy Downstream Installation adoption state");
  }
  expectString(adoption.cleanup, "Legacy Downstream Installation cleanup instructions");
  return adoption;
}

export function readManagedOwnership(dataRoot) {
  const paths = layout(dataRoot);
  const ownership = readJson(join(paths.state, "entrypoints.json"), "Command Ownership receipt");
  exactObject(ownership, "Command Ownership receipt", ownershipKeys);
  if (ownership.schemaVersion !== 1 || ownership.type !== "managed-command-ownership") fail("Malformed Command Ownership receipt");
  expectString(ownership.binDirectory, "managed bin directory");
  validatePairShape(ownership.createdFrom, "ownership creation pair");
  exactObject(ownership.dispatcher, "Managed Dispatcher identity", ["path", "sha256", "size"]);
  expectString(ownership.dispatcher.path, "Managed Dispatcher path");
  expectString(ownership.dispatcher.sha256, "Managed Dispatcher digest", sha256Pattern);
  if (!Number.isSafeInteger(ownership.dispatcher.size) || ownership.dispatcher.size < 0) fail("Malformed Managed Dispatcher identity");
  exactObject(ownership.entrypoints, "Command Ownership entrypoints", ["pi", "compatibility"]);
  validateEntrypoint(ownership.entrypoints.pi, "Command Ownership pi entrypoint");
  validateEntrypoint(ownership.entrypoints.compatibility, "Compatibility Entrypoint");
  const binDirectory = resolve(ownership.binDirectory);
  const dispatcherPath = join(paths.root, "dispatcher", "managed-dispatcher.mjs");
  if (resolve(ownership.entrypoints.pi.path) !== join(binDirectory, "pi")
    || resolve(ownership.entrypoints.compatibility.path) !== join(binDirectory, "pi-wait-for-user")
    || resolve(ownership.entrypoints.pi.target) !== dispatcherPath
    || resolve(ownership.entrypoints.compatibility.target) !== dispatcherPath
    || resolve(ownership.dispatcher.path) !== dispatcherPath) {
    fail("Command Ownership receipt escapes its owned paths");
  }
  validateStockIdentity(ownership.stock);
  expectDate(ownership.createdAt, "Command Ownership creation date");
  return ownership;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandPath(name, environment) {
  for (const directory of (environment.PATH || "").split(":")) {
    const candidate = resolve(directory || process.cwd(), name);
    if (!pathExists(candidate)) continue;
    let stat;
    try { stat = lstatSync(realpathSync(candidate)); } catch { continue; }
    if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
  }
  return null;
}

function isManagedDispatcherExecutable(path) {
  let executablePath;
  try { executablePath = realpathSync(path); } catch { return false; }
  const dispatcherDirectory = dirname(executablePath);
  if (basename(executablePath) !== "managed-dispatcher.mjs" || basename(dispatcherDirectory) !== "dispatcher") return false;
  const receiptPath = join(dispatcherDirectory, ".managed", "receipt.json");
  if (!pathExists(receiptPath)) return true; // A damaged Dispatcher-shaped target must still never become Stock Pi.
  try {
    const receipt = readJson(receiptPath, "Managed Dispatcher receipt");
    return receipt.type === "managed-dispatcher" && realpathSync(resolve(receipt.ownedPath)) === realpathSync(dispatcherDirectory);
  } catch {
    return true;
  }
}

function executableIdentity(path, environment, expected) {
  const executablePath = realpathSync(path);
  const stat = lstatSync(executablePath);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) fail(`Stock Pi is not executable: ${path}`);
  const baseIdentity = {
    resolvedPath: resolve(path),
    executablePath,
    sha256: sha256File(executablePath),
    size: stat.size,
  };
  if (expected && (baseIdentity.resolvedPath !== expected.resolvedPath
    || baseIdentity.executablePath !== expected.executablePath
    || baseIdentity.sha256 !== expected.sha256
    || baseIdentity.size !== expected.size)) fail(`Stock Pi identity changed at ${path}`);
  const observed = spawnSync(path, ["--version"], { encoding: "utf8", env: environment });
  if (observed.error || observed.status !== 0) fail(`Cannot read Stock Pi version from ${path}`);
  const version = observed.stdout.trim();
  if (!version) fail(`Stock Pi returned no version identity: ${path}`);
  return { ...baseIdentity, version };
}

function resolvedStockIdentity(environment) {
  const resolvedStock = commandPath("pi", environment);
  if (resolvedStock && isManagedDispatcherExecutable(resolvedStock)) {
    fail(`Resolved pi is another Managed Dispatcher, not Stock Pi: ${resolvedStock}`);
  }
  return resolvedStock ? executableIdentity(resolvedStock, environment) : null;
}

function entrypointMatches(entrypoint) {
  if (!pathExists(entrypoint.path)) return false;
  const stat = lstatSync(entrypoint.path);
  return stat.isSymbolicLink() && resolve(dirname(entrypoint.path), readlinkSync(entrypoint.path)) === resolve(entrypoint.target);
}

function assertEntrypointAvailable(entrypoint) {
  if (!pathExists(entrypoint.path)) return;
  if (!entrypointMatches(entrypoint)) fail(`Unowned foreign command collision: ${entrypoint.path}`);
}

function publishEntrypoint(entrypoint) {
  if (entrypointMatches(entrypoint)) return;
  try {
    symlinkSync(entrypoint.target, entrypoint.path);
  } catch (error) {
    if (error?.code === "EEXIST") fail(`Unowned foreign command collision: ${entrypoint.path}`);
    throw error;
  }
}

function compatibilityReceiptPath(paths) {
  return join(paths.state, "compatibility-entrypoint.json");
}

function readCompatibilityEntrypoint(paths) {
  const receipt = readJson(compatibilityReceiptPath(paths), "Compatibility Entrypoint receipt");
  exactObject(receipt, "Compatibility Entrypoint receipt", [
    "schemaVersion", "type", "path", "target", "createdFrom", "createdAt",
  ]);
  if (receipt.schemaVersion !== 1 || receipt.type !== "managed-compatibility-entrypoint") fail("Malformed Compatibility Entrypoint receipt");
  validatePairShape(receipt.createdFrom, "compatibility ownership creation pair");
  expectDate(receipt.createdAt, "compatibility ownership creation date");
  return validateEntrypoint({ path: receipt.path, target: receipt.target }, "Compatibility Entrypoint");
}

function dispatcherIdentity(path) {
  const target = resolve(path);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) fail(`Managed Dispatcher is missing or not executable: ${target}`);
  return { path: target, sha256: sha256File(target), size: stat.size };
}

function assertDispatcherIdentity(dispatcher) {
  const found = dispatcherIdentity(dispatcher.path);
  if (found.sha256 !== dispatcher.sha256 || found.size !== dispatcher.size) fail("Managed Dispatcher identity changed");
}

function validateBinDirectory(binDirectory) {
  if (pathExists(binDirectory) && (lstatSync(binDirectory).isSymbolicLink() || !lstatSync(binDirectory).isDirectory())) {
    fail(`Managed bin directory is foreign: ${binDirectory}`);
  }
  let ancestor = dirname(binDirectory);
  while (ancestor !== dirname(ancestor)) {
    if (pathExists(ancestor)) {
      const stat = lstatSync(ancestor);
      if (stat.isSymbolicLink() && stat.uid !== 0) {
        fail(`Managed bin directory ancestor is a foreign symbolic link: ${ancestor}`);
      }
    }
    ancestor = dirname(ancestor);
  }
}

function requireOwnedCompatibility(paths, expected, { allowMissing = false } = {}) {
  if (!pathExists(compatibilityReceiptPath(paths))) fail(`Unowned foreign command collision: ${expected.path}`);
  const installed = readCompatibilityEntrypoint(paths);
  if (resolve(installed.path) !== resolve(expected.path) || resolve(installed.target) !== resolve(expected.target)
    || ((!allowMissing || pathExists(installed.path)) && !entrypointMatches(installed))) {
    fail(`Compatibility Entrypoint ownership mismatch: ${expected.path}`);
  }
  return installed;
}

export function preflightManagedCommandOwnership(dataRoot, options = {}) {
  const environment = options.environment || process.env;
  const binDirectory = resolve(options.binDirectory || defaultManagedBinDirectory(environment));
  validateBinDirectory(binDirectory);
  const paths = layout(dataRoot);
  const expectedCompatibility = {
    path: join(binDirectory, "pi-wait-for-user"),
    target: join(paths.root, "dispatcher", "managed-dispatcher.mjs"),
  };
  if (pathExists(expectedCompatibility.path)) requireOwnedCompatibility(paths, expectedCompatibility);
  if (options.managePi) {
    const piPath = join(binDirectory, "pi");
    if (pathExists(piPath)) {
      const ownershipPath = join(paths.state, "entrypoints.json");
      if (!pathExists(ownershipPath)) fail(`Unowned foreign command collision: ${piPath}`);
      const ownership = readManagedOwnership(dataRoot);
      if (resolve(ownership.entrypoints.pi.path) !== piPath || !entrypointMatches(ownership.entrypoints.pi)) {
        fail(`Command Ownership pi entrypoint mismatch: ${piPath}`);
      }
    }
  }
  return { binDirectory };
}

function verifiedActiveSelection(dataRoot) {
  verifyManagedInstallation(dataRoot);
  return validateActivePair(dataRoot);
}

export function installManagedCompatibility(dataRoot, options = {}) {
  const environment = options.environment || process.env;
  const binDirectory = resolve(options.binDirectory || defaultManagedBinDirectory(environment));
  const selected = verifiedActiveSelection(dataRoot);
  return withLifecycleLock(dataRoot, "install Compatibility Entrypoint", () => {
    const paths = initializeLayout(dataRoot);
    const expected = {
      path: join(binDirectory, "pi-wait-for-user"),
      target: join(paths.root, "dispatcher", "managed-dispatcher.mjs"),
    };
    const receiptPath = compatibilityReceiptPath(paths);
    if (pathExists(receiptPath)) {
      requireOwnedCompatibility(paths, expected, { allowMissing: true });
    } else if (pathExists(expected.path)) fail(`Unowned foreign command collision: ${expected.path}`);
    validateBinDirectory(binDirectory);
    const dispatcher = dispatcherIdentity(publishStableDispatcher(paths, selected));
    if (dispatcher.path !== expected.target) fail("Managed Dispatcher path mismatch");
    mkdir(binDirectory);
    if (!pathExists(receiptPath)) {
      atomicWrite(receiptPath, {
        schemaVersion: 1,
        type: "managed-compatibility-entrypoint",
        ...expected,
        createdFrom: selected.pair,
        createdAt: new Date().toISOString(),
      });
    }
    options.checkpoint?.("compatibility-receipt-published");
    publishEntrypoint(expected);
    return "installed";
  });
}

export function enableManagedOwnership(dataRoot, options = {}) {
  const environment = options.environment || process.env;
  const binDirectory = resolve(options.binDirectory || defaultManagedBinDirectory(environment));
  const selected = verifiedActiveSelection(dataRoot);
  return withLifecycleLock(dataRoot, "enable Command Ownership", () => {
    const paths = initializeLayout(dataRoot);
    const ownershipPath = join(paths.state, "entrypoints.json");
    const expectedDispatcherPath = join(paths.root, "dispatcher", "managed-dispatcher.mjs");
    let ownership;
    let pendingOwnership;
    let alreadyEnabled = false;
    if (pathExists(ownershipPath)) {
      ownership = readManagedOwnership(dataRoot);
      if (resolve(ownership.binDirectory) !== binDirectory || resolve(ownership.dispatcher.path) !== expectedDispatcherPath) {
        fail("Command Ownership configuration mismatch");
      }
    } else {
      const pi = { path: join(binDirectory, "pi"), target: expectedDispatcherPath };
      const compatibility = { path: join(binDirectory, "pi-wait-for-user"), target: expectedDispatcherPath };
      if (pathExists(pi.path)) fail(`Unowned foreign command collision: ${pi.path}`);
      if (pathExists(compatibilityReceiptPath(paths))) requireOwnedCompatibility(paths, compatibility, { allowMissing: true });
      else if (pathExists(compatibility.path)) fail(`Unowned foreign command collision: ${compatibility.path}`);
      validateBinDirectory(binDirectory);
      pendingOwnership = {
        entrypoints: { pi, compatibility },
        stock: resolvedStockIdentity(environment),
      };
    }

    validateBinDirectory(binDirectory);
    if (ownership && !entrypointMatches(ownership.entrypoints.pi)) {
      assertEntrypointAvailable(ownership.entrypoints.pi);
      assertEntrypointAvailable(ownership.entrypoints.compatibility);
      ownership = {
        ...ownership,
        stock: resolvedStockIdentity(environment),
        createdFrom: selected.pair,
        createdAt: new Date().toISOString(),
      };
      atomicWrite(ownershipPath, ownership);
    }
    const dispatcher = dispatcherIdentity(publishStableDispatcher(paths, selected));
    if (ownership) {
      if (ownership.dispatcher.sha256 !== dispatcher.sha256 || ownership.dispatcher.size !== dispatcher.size) {
        fail("Managed Dispatcher identity changed");
      }
      assertDispatcherIdentity(ownership.dispatcher);
      alreadyEnabled = entrypointMatches(ownership.entrypoints.pi) && entrypointMatches(ownership.entrypoints.compatibility);
    } else {
      ownership = {
        schemaVersion: 1,
        type: "managed-command-ownership",
        binDirectory,
        dispatcher,
        entrypoints: pendingOwnership.entrypoints,
        stock: pendingOwnership.stock,
        createdFrom: selected.pair,
        createdAt: new Date().toISOString(),
      };
      mkdir(binDirectory);
      atomicWrite(ownershipPath, ownership);
    }
    assertEntrypointAvailable(ownership.entrypoints.pi);
    assertEntrypointAvailable(ownership.entrypoints.compatibility);
    publishEntrypoint(ownership.entrypoints.compatibility);
    options.checkpoint?.("compatibility-entrypoint-published");
    publishEntrypoint(ownership.entrypoints.pi);
    options.checkpoint?.("pi-entrypoint-published");

    const resolvedCommand = commandPath("pi", environment);
    const resolvesToManagedDispatcher = resolvedCommand
      && basename(resolvedCommand) === basename(ownership.entrypoints.pi.path)
      && realpathSync(dirname(resolvedCommand)) === realpathSync(dirname(ownership.entrypoints.pi.path))
      && entrypointMatches(ownership.entrypoints.pi)
      && realpathSync(resolvedCommand) === realpathSync(ownership.dispatcher.path);
    if (!resolvesToManagedDispatcher) {
      const pathRemediation = resolvedCommand
        ? `Put ${binDirectory} before ${dirname(resolvedCommand)} in PATH`
        : `Add ${binDirectory} to the front of PATH, for example: export PATH=${shellQuote(binDirectory)}:"$PATH"`;
      fail(`Managed Dispatcher is installed but current command resolution selects ${resolvedCommand || "no pi command"}. ${pathRemediation}, run \`hash -r\`, then rerun: pi-wait-for-user managed enable --bin-dir ${shellQuote(binDirectory)}`);
    }
    return alreadyEnabled ? "already enabled" : "enabled";
  });
}

export function inspectStockPiIdentity(dataRoot, { environment = process.env } = {}) {
  const recorded = readManagedOwnership(dataRoot).stock;
  if (!recorded) return { recorded: null, divergence: null };
  try {
    const current = executableIdentity(recorded.resolvedPath, environment, recorded);
    return { recorded, divergence: canonicalJson(current) === canonicalJson(recorded) ? null : "Stock Pi identity changed" };
  } catch (error) {
    return { recorded, divergence: error instanceof Error ? error.message : String(error) };
  }
}

export function executeStockPi(dataRoot, args, { environment = process.env } = {}) {
  const ownership = readManagedOwnership(dataRoot);
  if (!ownership.stock) fail("No Stock Pi executable was recorded when Command Ownership was enabled");
  const stock = ownership.stock;
  if (resolve(stock.resolvedPath) === resolve(ownership.entrypoints.pi.path)
    || resolve(stock.executablePath) === resolve(ownership.dispatcher.path)
    || isManagedDispatcherExecutable(stock.resolvedPath)) {
    fail("Refusing dispatcher recursion while executing Stock Pi");
  }
  let current;
  try { current = executableIdentity(stock.resolvedPath, environment, stock); } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^Stock Pi identity changed/.test(message)) fail(message);
    fail(`Recorded Stock Pi is unavailable: ${message}`);
  }
  if (canonicalJson(current) !== canonicalJson(stock)) fail(`Stock Pi identity changed at ${stock.resolvedPath}`);
  console.error("Warning: Stock Pi cannot open downstream session files. Use it only for Stock Pi sessions.");
  if (realpathSync(stock.resolvedPath) !== current.executablePath) fail(`Stock Pi identity changed at ${stock.resolvedPath}`);
  if (typeof process.execve === "function") process.execve(stock.resolvedPath, [stock.resolvedPath, ...args], environment);
  const result = spawnSync(stock.resolvedPath, args, { stdio: "inherit", env: environment });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function disableManagedCommandOwnership(dataRoot) {
  const paths = initializeLayout(dataRoot);
  const ownershipPath = join(paths.state, "entrypoints.json");
  if (!existsSync(ownershipPath)) return "already disabled";
  return withLifecycleLock(dataRoot, "disable Command Ownership", () => {
    const ownership = readJson(ownershipPath, "Command Ownership receipt");
    let entrypoint;
    if (ownership.type === "managed-pi-entrypoint") {
      exactObject(ownership, "legacy Command Ownership receipt", ["schemaVersion", "type", "path", "target"]);
      if (ownership.schemaVersion !== 1) fail("Malformed legacy Command Ownership receipt");
      entrypoint = { path: ownership.path, target: ownership.target };
    } else {
      const managedOwnership = readManagedOwnership(dataRoot);
      if (pathExists(compatibilityReceiptPath(paths))) {
        requireOwnedCompatibility(paths, managedOwnership.entrypoints.compatibility);
      } else if (!entrypointMatches(managedOwnership.entrypoints.compatibility)) {
        fail(`Compatibility Entrypoint ownership mismatch: ${managedOwnership.entrypoints.compatibility.path}`);
      }
      entrypoint = managedOwnership.entrypoints.pi;
    }
    validateBinDirectory(dirname(entrypoint.path));
    const path = resolve(entrypoint.path);
    if (!pathExists(path)) return "already disabled";
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink() || resolve(dirname(path), readlinkSync(path)) !== resolve(entrypoint.target)) fail("Command Ownership pi entrypoint mismatch");
    unlinkSync(path);
    return "disabled";
  });
}
