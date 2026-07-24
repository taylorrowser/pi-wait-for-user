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
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
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
    uninstallPending: join(root, "state", "uninstall-pending.json"),
    rollback: join(root, "state", "rollback-transaction.json"),
    holdClear: join(root, "state", "update-hold-clear-transaction.json"),
    pins: join(root, "state", "pinned-releases.json"),
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

function assertOutsideSharedPiData(dataRoot, environment = process.env) {
  const root = resolve(dataRoot);
  const sharedRoots = [
    environment.HOME && join(environment.HOME, ".pi", "agent"),
    environment.PI_CODING_AGENT_DIR,
  ].filter(Boolean).map((path) => resolve(path));
  if (sharedRoots.some((shared) => root === shared || root.startsWith(`${shared}${sep}`) || shared.startsWith(`${root}${sep}`))) {
    fail(`Managed data root overlaps shared Pi data: ${root}`);
  }
}

function initializeLayout(dataRoot) {
  assertOutsideSharedPiData(dataRoot);
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

export function managedProcessStatus(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return { status: "dead", identity: null };
    if (error?.code !== "EPERM") return { status: "unknown", identity: null };
  }
  const identity = managedProcessStartIdentity(pid);
  return identity ? { status: "live", identity } : { status: "unknown", identity: null };
}

export function managedProcessIdentityIsLive(pid, startIdentity) {
  const observed = managedProcessStatus(pid);
  return observed.status === "live" && observed.identity === startIdentity;
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
  const ownerProcess = managedProcessStatus(active.pid);
  if (ownerProcess.status === "unknown"
    || (ownerProcess.status === "live" && ownerProcess.identity === active.processStartIdentity)) {
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
    const legacy = plainObject(active)
      && canonicalJson(Object.keys(active).sort()) === canonicalJson(["schemaVersion", "pid", "token", "operation", "startedAt"].sort());
    exactObject(active, "lifecycle lock", legacy
      ? ["schemaVersion", "pid", "token", "operation", "startedAt"]
      : ["schemaVersion", "pid", "processStartIdentity", "token", "operation", "startedAt"]);
    if (active.schemaVersion !== 1 || !Number.isSafeInteger(active.pid) || active.pid < 1) fail("Malformed lifecycle lock");
    if (!legacy) expectString(active.processStartIdentity, "lifecycle lock process identity");
    expectString(active.token, "lifecycle lock token");
    expectString(active.operation, "lifecycle lock operation");
    expectDate(active.startedAt, "lifecycle lock start date");
    const activeProcess = managedProcessStatus(active.pid);
    if ((legacy && activeProcess.status !== "dead")
      || (!legacy && (activeProcess.status === "unknown"
        || (activeProcess.status === "live" && activeProcess.identity === active.processStartIdentity)))) {
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

function validateDispatcherReceipt(value, destination) {
  exactObject(value, "Managed Dispatcher receipt", [
    "schemaVersion", "type", "ownedPath", "managerReleaseId", "platform", "sourceArtifact", "createdAt", "payload",
  ]);
  if (value.schemaVersion !== 1 || value.type !== "managed-dispatcher" || resolve(value.ownedPath) !== destination
    || !Array.isArray(value.payload)) fail("Malformed Managed Dispatcher receipt");
  ensureIdentifier(value.managerReleaseId, "Dispatcher Manager Release ID");
  ensurePlatform(value.platform);
  exactObject(value.sourceArtifact, "Dispatcher source artifact", ["name", "sha256", "size"]);
  ensureRelativePath(value.sourceArtifact.name, "Dispatcher source artifact name");
  expectString(value.sourceArtifact.sha256, "Dispatcher source artifact digest", sha256Pattern);
  if (!Number.isSafeInteger(value.sourceArtifact.size) || value.sourceArtifact.size < 0) fail("Malformed Dispatcher source artifact");
  expectDate(value.createdAt, "Dispatcher creation date");
  value.payload.forEach((entry, index) => validatePayloadEntry(entry, `Managed Dispatcher receipt payload[${index}]`));
  return value;
}

function validateDispatcherPayload(destination, receipt) {
  const installedPayload = createPayloadInventory(destination).filter((entry) => !entry.path.startsWith(".managed/"));
  comparePayload(installedPayload, receipt.payload);
  return installedPayload;
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
    const receipt = validateDispatcherReceipt(readJson(embeddedPath, "Managed Dispatcher receipt"), destination);
    const installedPayload = validateDispatcherPayload(destination, receipt);
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

function samePair(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validatePairShape(value, label) {
  exactObject(value, label, ["managerReleaseId", "downstreamReleaseId", "manifestSha256", "platform"]);
  ensureIdentifier(value.managerReleaseId, `${label} Manager Release ID`);
  ensureIdentifier(value.downstreamReleaseId, `${label} Downstream Release ID`);
  expectString(value.manifestSha256, `${label} manifest digest`, sha256Pattern);
  ensurePlatform(value.platform);
  return value;
}

function validateUpdateHold(value, label = "Update Hold") {
  exactObject(value, label, ["schemaVersion", "type", "releaseId", "createdAt"]);
  if (value.schemaVersion !== 1 || value.type !== "update-hold") fail(`Malformed ${label}`);
  ensureIdentifier(value.releaseId, `${label} release ID`);
  expectDate(value.createdAt, `${label} creation date`);
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
  const unique = pairs.filter((pair, index) => pairs.findIndex((entry) => samePair(entry, pair)) === index);
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

      installedPairs(paths);
      readVerifiedPinnedPairs(paths);
      let previous = null;
      if (existsSync(paths.activation)) {
        const existingClear = readUpdateHoldClearTransaction(paths);
        if (existingClear) {
          const state = pairTransactionState(dataRoot, existingClear);
          if (state === "committed") clearManagedUpdateHoldLocked(dataRoot, existingClear.releaseId);
          else if (state === "not-committed") unlinkSync(paths.holdClear);
          else fail("Update Hold clear transaction does not match the selected Activation");
        }
        const current = readActivation(dataRoot);
        if (samePair(current.active, pair)) {
          updateLegacyInstallationAdoption(paths, { legacyPaths, legacyAdopted, legacyPath, releaseId: manifest.releaseId });
          return current;
        }
        previous = current.active;
        const hold = readManagedUpdateHold(dataRoot);
        if (hold?.releaseId === pair.downstreamReleaseId) {
          atomicWrite(paths.holdClear, {
            schemaVersion: 1,
            type: "update-hold-clear-transaction",
            source: current.active,
            target: pair,
            releaseId: hold.releaseId,
            createdAt: new Date().toISOString(),
          });
        }
      }
      checkpoint?.("before-activation-switch");
      const activation = {
        schemaVersion: 1,
        type: "activation",
        createdAt: new Date().toISOString(),
        active: pair,
        previous,
      };
      atomicWrite(paths.activation, activation);
      const cleanupIssues = [];
      try {
        updateLegacyInstallationAdoption(paths, { legacyPaths, legacyAdopted, legacyPath, releaseId: manifest.releaseId });
      } catch (error) {
        cleanupIssues.push(`Legacy Downstream Installation adoption: ${error instanceof Error ? error.message : String(error)}`);
        recordManagedUpdateDiagnostic(dataRoot, "post-activation Legacy Downstream Installation adoption", error);
      }
      checkpoint?.("after-activation-switch");
      try { pruneInstalledPairsLocked(dataRoot); } catch (error) {
        cleanupIssues.push(`retention: ${error instanceof Error ? error.message : String(error)}`);
        recordManagedUpdateDiagnostic(dataRoot, "post-activation retention", error);
      }
      if (cleanupIssues.length > 0) activation.cleanupIssues = cleanupIssues;
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

export function managedCandidateIdentityConflict(dataRoot, manifest, manifestSha256, platform) {
  const paths = layout(dataRoot);
  const managerArtifact = manifest.manager.artifacts[0];
  const managerPath = join(paths.managers, manifest.manager.releaseId);
  const managerReceiptPath = receiptPath(paths, "manager", manifest.manager.releaseId);
  if (pathExists(managerReceiptPath)) {
    const receiptValue = readJson(managerReceiptPath, "manager receipt");
    const receipt = validateReceipt(receiptValue, "manager", managerPath, {
      managerReleaseId: manifest.manager.releaseId,
      downstreamReleaseId: manifest.releaseId,
      platform: receiptValue.platform,
    });
    if (canonicalJson(receipt.sourceArtifact) !== canonicalJson(managerArtifact)) {
      return `signed candidate reuses immutable Manager Release identity ${manifest.manager.releaseId}`;
    }
  }
  const downstreamPath = join(paths.releases, manifest.releaseId);
  const downstreamReceiptPath = receiptPath(paths, "downstream", manifest.releaseId);
  if (pathExists(downstreamReceiptPath)) {
    const receiptValue = readJson(downstreamReceiptPath, "downstream receipt");
    const receipt = validateReceipt(receiptValue, "downstream", downstreamPath, {
      managerReleaseId: receiptValue.managerReleaseId,
      downstreamReleaseId: manifest.releaseId,
      platform: receiptValue.platform,
    });
    const archive = manifest.platformArchives.find((entry) => entry.platform === platform)?.artifact;
    if (receipt.manifestSha256 !== manifestSha256
      || !archive || canonicalJson(receipt.sourceArtifact) !== canonicalJson(archive)) {
      return `signed candidate reuses immutable Downstream Release identity ${manifest.releaseId}`;
    }
  }
  return null;
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

function updateHoldPath(paths) {
  return join(paths.state, "update-hold.json");
}

function readUpdateHoldRecord(paths) {
  const path = updateHoldPath(paths);
  if (!pathExists(path)) return null;
  return validateUpdateHold(readJson(path, "Update Hold"));
}

function readUpdateHoldClearTransaction(paths) {
  if (!pathExists(paths.holdClear)) return null;
  const value = readJson(paths.holdClear, "Update Hold clear transaction");
  exactObject(value, "Update Hold clear transaction", ["schemaVersion", "type", "source", "target", "releaseId", "createdAt"]);
  if (value.schemaVersion !== 1 || value.type !== "update-hold-clear-transaction") {
    fail("Malformed Update Hold clear transaction");
  }
  validatePairShape(value.source, "Update Hold clear source");
  validatePairShape(value.target, "Update Hold clear target");
  ensureIdentifier(value.releaseId, "Update Hold clear release ID");
  expectDate(value.createdAt, "Update Hold clear creation date");
  if (value.releaseId !== value.target.downstreamReleaseId || samePair(value.source, value.target)) {
    fail("Update Hold clear transaction pair mismatch");
  }
  return value;
}

function pairTransactionState(dataRoot, transaction) {
  if (!transaction) return null;
  const active = readActivation(dataRoot).active;
  if (samePair(active, transaction.target)) return "committed";
  if (samePair(active, transaction.source)) return "not-committed";
  return "superseded";
}

function readRollbackTransaction(paths) {
  if (!pathExists(paths.rollback)) return null;
  const value = readJson(paths.rollback, "rollback transaction");
  exactObject(value, "rollback transaction", ["schemaVersion", "type", "source", "target", "hold", "createdAt"]);
  if (value.schemaVersion !== 1 || value.type !== "rollback-transaction") fail("Malformed rollback transaction");
  validatePairShape(value.source, "rollback transaction source");
  validatePairShape(value.target, "rollback transaction target");
  validateUpdateHold(value.hold, "rollback transaction Update Hold");
  expectDate(value.createdAt, "rollback transaction creation date");
  if (value.hold.releaseId !== value.source.downstreamReleaseId) fail("Rollback transaction Update Hold mismatch");
  return value;
}

export function readManagedUpdateHold(dataRoot) {
  const paths = layout(dataRoot);
  const clearTransaction = readUpdateHoldClearTransaction(paths);
  if (pairTransactionState(dataRoot, clearTransaction) === "committed") return null;
  const transaction = readRollbackTransaction(paths);
  if (pairTransactionState(dataRoot, transaction) === "committed") return transaction.hold;
  return readUpdateHoldRecord(paths);
}

function installedPairForRelease(paths, releaseId, { allowMissingPairs = [] } = {}) {
  ensureIdentifier(releaseId, "local release ID");
  const releasePath = join(paths.releases, releaseId);
  const centralPath = receiptPath(paths, "downstream", releaseId);
  if (!pathExists(centralPath)) return null;
  const receipt = readJson(centralPath, "downstream receipt");
  const pair = {
    managerReleaseId: receipt.managerReleaseId,
    downstreamReleaseId: releaseId,
    manifestSha256: receipt.manifestSha256,
    platform: receipt.platform,
  };
  validatePairShape(pair, "installed local pair");
  if (pathExists(releasePath)) {
    const verifiedReceipt = readReceiptCopies(paths, "downstream", releaseId, releasePath, pair);
    comparePayload(payloadWithoutManagerFiles(releasePath), verifiedReceipt.payload);
  } else if (allowMissingPairs.some((pending) => samePair(pending, pair))) {
    validateReceipt(receipt, "downstream", releasePath, pair);
  } else return null;
  return pair;
}

function installedPairs(paths, options = {}) {
  const receiptDirectory = ensureNoSymlinkPath(paths.receipts, join(paths.receipts, "releases"), "Downstream receipt directory");
  const releaseDirectory = ensureNoSymlinkPath(paths.root, paths.releases, "Downstream Release directory");
  ensureManagedDirectory(receiptDirectory);
  ensureManagedDirectory(releaseDirectory);
  const pairs = readdirSync(receiptDirectory).sort().map((name) => {
    if (!name.endsWith(".json")) fail(`Foreign Downstream Release receipt: ${name}`);
    const releaseId = name.slice(0, -5);
    ensureIdentifier(releaseId, "Downstream Release receipt ID");
    const pair = installedPairForRelease(paths, releaseId, options);
    if (!pair) fail(`Inconsistent receipt for Downstream Release ${releaseId}`);
    return pair;
  });
  for (const releaseId of readdirSync(releaseDirectory)) {
    ensureIdentifier(releaseId, "installed Downstream Release ID");
    if (!pairs.some((pair) => pair.downstreamReleaseId === releaseId)) {
      fail(`Installed Downstream Release has no receipt: ${releaseId}`);
    }
  }
  return pairs;
}

function readPinnedPairs(paths) {
  if (!pathExists(paths.pins)) return [];
  const value = readJson(paths.pins, "Pinned Releases state");
  exactObject(value, "Pinned Releases state", ["schemaVersion", "type", "pairs"]);
  if (value.schemaVersion !== 1 || value.type !== "pinned-releases" || !Array.isArray(value.pairs)) {
    fail("Malformed Pinned Releases state");
  }
  value.pairs.forEach((pair) => validatePairShape(pair, "Pinned Release pair"));
  if (new Set(value.pairs.map((pair) => pair.downstreamReleaseId)).size !== value.pairs.length) {
    fail("Malformed Pinned Releases state");
  }
  return value.pairs;
}

function readVerifiedPinnedPairs(paths) {
  return readPinnedPairs(paths).map((pair) => {
    const installed = installedPairForRelease(paths, pair.downstreamReleaseId);
    if (!installed || !samePair(installed, pair)) {
      fail(`Pinned Release identity mismatch: ${pair.downstreamReleaseId}`);
    }
    return pair;
  });
}

function writePinnedPairs(paths, pairs) {
  if (pairs.length === 0) {
    if (pathExists(paths.pins)) unlinkSync(paths.pins);
    return;
  }
  atomicWrite(paths.pins, { schemaVersion: 1, type: "pinned-releases", pairs });
}

export function pinManagedRelease(dataRoot, releaseId) {
  return withLifecycleLock(dataRoot, `pin ${releaseId || "active release"}`, () => {
    const paths = layout(dataRoot);
    const selectedId = releaseId || readActivation(dataRoot).active.downstreamReleaseId;
    const pair = installedPairForRelease(paths, selectedId);
    if (!pair) fail(`No locally installed verified pair exists for ${selectedId}`);
    verifyPair(dataRoot, pair);
    const pins = readVerifiedPinnedPairs(paths);
    if (pins.some((entry) => entry.downstreamReleaseId === selectedId)) return { kind: "already-pinned", pair };
    writePinnedPairs(paths, [...pins, pair]);
    return { kind: "pinned", pair };
  });
}

export function unpinManagedRelease(dataRoot, releaseId) {
  return withLifecycleLock(dataRoot, `unpin ${releaseId || "active release"}`, () => {
    const paths = layout(dataRoot);
    const selectedId = releaseId || readActivation(dataRoot).active.downstreamReleaseId;
    ensureIdentifier(selectedId, "Pinned Release ID");
    const pins = readVerifiedPinnedPairs(paths);
    const retained = pins.filter((pair) => pair.downstreamReleaseId !== selectedId);
    if (retained.length === pins.length) return { kind: "already-unpinned", releaseId: selectedId };
    writePinnedPairs(paths, retained);
    return { kind: "unpinned", releaseId: selectedId };
  });
}

export function rollbackManagedInstallation(dataRoot, options = {}) {
  const releaseId = options.releaseId;
  return withLifecycleLock(dataRoot, `rollback${releaseId ? ` to ${releaseId}` : ""}`, () => {
    const paths = layout(dataRoot);
    const interrupted = readRollbackTransaction(paths);
    if (interrupted) {
      const state = pairTransactionState(dataRoot, interrupted);
      if (state === "committed") {
        atomicWrite(updateHoldPath(paths), interrupted.hold);
        unlinkSync(paths.rollback);
      } else if (state === "not-committed") unlinkSync(paths.rollback);
      else fail("Rollback transaction does not match the selected Activation");
    }
    const current = readActivation(dataRoot);
    const target = releaseId ? installedPairForRelease(paths, releaseId) : current.previous;
    if (!target) {
      if (releaseId) fail(`No locally installed verified pair exists for ${releaseId}`);
      return { kind: "no-target", activation: current };
    }
    if (samePair(target, current.active)) {
      return { kind: "already-active", activation: current };
    }
    verifyPair(dataRoot, target);
    options.checkpoint?.("rollback-target-verified");
    installedPairs(paths);
    readVerifiedPinnedPairs(paths);
    readUpdateHoldRecord(paths); // Refuse malformed or substituted state before changing Activation.
    const hold = {
      schemaVersion: 1,
      type: "update-hold",
      releaseId: current.active.downstreamReleaseId,
      createdAt: new Date().toISOString(),
    };
    const rolledBack = {
      schemaVersion: 1,
      type: "activation",
      createdAt: new Date().toISOString(),
      active: target,
      previous: current.active,
    };
    atomicWrite(paths.rollback, {
      schemaVersion: 1,
      type: "rollback-transaction",
      source: current.active,
      target,
      hold,
      createdAt: new Date().toISOString(),
    });
    atomicWrite(updateHoldPath(paths), hold);
    options.checkpoint?.("before-rollback-switch");
    atomicWrite(paths.activation, rolledBack);
    options.checkpoint?.("rollback-activation-committed");
    const cleanupIssues = [];
    try { unlinkSync(paths.rollback); } catch (error) {
      cleanupIssues.push(`transaction retirement: ${error instanceof Error ? error.message : String(error)}`);
      recordManagedUpdateDiagnostic(dataRoot, "rollback transaction retirement", error);
    }
    options.checkpoint?.("after-rollback-switch");
    try { pruneInstalledPairsLocked(dataRoot); } catch (error) {
      cleanupIssues.push(`retention: ${error instanceof Error ? error.message : String(error)}`);
      recordManagedUpdateDiagnostic(dataRoot, "post-rollback retention", error);
    }
    return {
      kind: "rolled-back",
      activation: rolledBack,
      heldReleaseId: current.active.downstreamReleaseId,
      cleanupIssues,
    };
  });
}

function clearManagedUpdateHoldLocked(dataRoot, releaseId, checkpoint) {
  const paths = layout(dataRoot);
  const transaction = readRollbackTransaction(paths);
  const clearTransaction = readUpdateHoldClearTransaction(paths);
  if (clearTransaction && (!releaseId || clearTransaction.releaseId === releaseId)) {
    const projected = readUpdateHoldRecord(paths);
    if (projected?.releaseId === clearTransaction.releaseId) unlinkSync(updateHoldPath(paths));
    checkpoint?.("update-hold-projection-cleared");
    if (transaction?.hold.releaseId === clearTransaction.releaseId) unlinkSync(paths.rollback);
    checkpoint?.("rollback-transaction-retired-after-update");
    unlinkSync(paths.holdClear);
    checkpoint?.("update-hold-clear-transaction-retired");
    return true;
  }
  const transactionHold = pairTransactionState(dataRoot, transaction) === "committed" ? transaction.hold : null;
  if (transaction && !transactionHold) unlinkSync(paths.rollback);
  const projected = readUpdateHoldRecord(paths);
  const hold = transactionHold || projected;
  if (!hold || (releaseId && hold.releaseId !== releaseId)) return false;
  if (projected?.releaseId === hold.releaseId) unlinkSync(updateHoldPath(paths));
  if (transactionHold?.releaseId === hold.releaseId) unlinkSync(paths.rollback);
  return true;
}

export function clearManagedUpdateHoldForRelease(dataRoot, releaseId, options = {}) {
  ensureIdentifier(releaseId, "Update Hold release ID");
  if (options.lifecycleCapability !== undefined) {
    assertLifecycleCapability(options.lifecycleCapability);
    return clearManagedUpdateHoldLocked(dataRoot, releaseId, options.checkpoint);
  }
  return withLifecycleLock(dataRoot, `clear Update Hold for ${releaseId}`, () => (
    clearManagedUpdateHoldLocked(dataRoot, releaseId, options.checkpoint)
  ));
}

export function clearManagedUpdateHold(dataRoot) {
  return withLifecycleLock(dataRoot, "clear Update Hold", () => (
    clearManagedUpdateHoldLocked(dataRoot) ? "cleared" : "already clear"
  ));
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

function livePairLeases(paths, pair, { removeStale = true } = {}) {
  const directory = pairLeaseDirectory(paths, pair);
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) fail("Pair lease directory is foreign");
  validatePairLeaseDirectory(paths, pair);
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
    const observed = managedProcessStatus(lease.pid);
    if (observed.status === "unknown" || (observed.status === "live" && observed.identity === lease.processStartIdentity)) {
      live.push(path);
    } else if (removeStale) unlinkSync(path);
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
      const processStatus = managedProcessStatus(pid);
      if (processStatus.status !== "live") fail("Cannot identify pair lease process");
      atomicWrite(path, { ...lease, pid, processStartIdentity: processStatus.identity });
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
    if (owner.type === "managed-tombstone") {
      exactObject(owner, "tombstone receipt", ["schemaVersion", "type", "ownedPath", "token", "scope"]);
      exactObject(owner.scope, "tombstone scope", ["kind", "sourcePath", "identity"]);
      ensureIdentifier(owner.scope.kind, "tombstone kind");
      expectString(owner.scope.sourcePath, "tombstone source path");
      expectString(owner.scope.identity, "tombstone identity", sha256Pattern);
      const managedRoot = dirname(dirname(path));
      const sourcePath = ensureInside(managedRoot, owner.scope.sourcePath, "Tombstone source path");
      const expectedParent = owner.scope.kind === "downstream" ? join(managedRoot, "downstream-releases")
        : owner.scope.kind === "manager" ? join(managedRoot, "managers")
          : owner.scope.kind === "dispatcher" ? managedRoot : null;
      if (!expectedParent || (owner.scope.kind === "dispatcher"
        ? sourcePath !== join(managedRoot, "dispatcher")
        : dirname(sourcePath) !== expectedParent)) return false;
      return owner.schemaVersion === 1 && resolve(owner.ownedPath) === resolve(path) && uuidPattern.test(owner.token)
        && basename(path) === `${owner.scope.kind}.tombstone-${owner.token}`;
    }
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
  const unique = pairs.filter((pair, index) => pairs.findIndex((entry) => samePair(entry, pair)) === index);
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

function removeThroughTombstone(paths, source, kind, identity, checkpoint, checkpointPrefix = kind) {
  expectString(identity, "tombstone receipt identity", sha256Pattern);
  const token = randomUUID();
  const tombstone = join(paths.temporary, `${kind}.tombstone-${token}`);
  mkdirSync(tombstone, { mode: 0o700 });
  writeFileSync(join(tombstone, ".owner.json"), serializeMetadata({
    schemaVersion: 1,
    type: "managed-tombstone",
    ownedPath: tombstone,
    token,
    scope: { kind, sourcePath: resolve(source), identity },
  }), { flag: "wx", mode: 0o600 });
  checkpoint?.(`${checkpointPrefix}-tombstone-created`);
  chmodSync(source, 0o700);
  renameSync(source, join(tombstone, "payload"));
  checkpoint?.(`${checkpointPrefix}-tombstone-renamed`);
  removeStage(tombstone);
  checkpoint?.(`${checkpointPrefix}-tombstone-removed`);
}

function removeInstalledPairLocked(dataRoot, pair, { mode = "retention", checkpoint } = {}) {
  exactObject(pair, "cleanup pair", ["managerReleaseId", "downstreamReleaseId", "manifestSha256", "platform"]);
  validatePairShape(pair, "cleanup pair");
  if (!["retention", "uninstall"].includes(mode)) fail("Invalid pair removal mode");
  const paths = layout(dataRoot);
  const activation = mode === "uninstall" ? null : readActivation(dataRoot);
  if (mode === "retention" && samePair(pair, activation.active)) fail("Cannot remove the active pair");
  if (mode === "retention" && activation.previous && samePair(pair, activation.previous)) fail("Cannot remove the retained previous pair");
  if (livePairLeases(paths, pair).length > 0) {
    writePendingPairs(paths, [...readPendingPairs(paths), pair]);
    return "deferred";
  }
  if (mode === "retention") writePendingPairs(paths, [...readPendingPairs(paths), pair]);
  const releasePath = join(paths.releases, pair.downstreamReleaseId);
  const centralReleaseReceipt = ensureNoSymlinkPath(
    paths.receipts,
    receiptPath(paths, "downstream", pair.downstreamReleaseId),
    "Downstream cleanup receipt path",
  );
  if (existsSync(releasePath)) {
    readReceiptCopies(paths, "downstream", pair.downstreamReleaseId, releasePath, pair);
    removeThroughTombstone(
      paths,
      releasePath,
      "downstream",
      metadataDigest({ kind: "downstream", pair }),
      checkpoint,
      "uninstall-downstream",
    );
    checkpoint?.("uninstall-downstream-payload-removed");
    unlinkSync(centralReleaseReceipt);
    checkpoint?.("uninstall-downstream-receipt-removed");
  } else if (existsSync(centralReleaseReceipt)) {
    validateReceipt(readJson(centralReleaseReceipt, "downstream receipt"), "downstream", releasePath, pair);
    unlinkSync(centralReleaseReceipt);
  }

  const retainedManager = mode === "uninstall" ? false : [activation.active, activation.previous]
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
      removeThroughTombstone(
        paths,
        managerPath,
        "manager",
        metadataDigest({ kind: "manager", pair }),
        checkpoint,
        "uninstall-manager",
      );
      checkpoint?.("uninstall-manager-payload-removed");
      unlinkSync(centralManagerReceipt);
      checkpoint?.("uninstall-manager-receipt-removed");
    } else if (existsSync(centralManagerReceipt)) {
      validateReceipt(readJson(centralManagerReceipt, "manager receipt"), "manager", managerPath, pair);
      unlinkSync(centralManagerReceipt);
    }
  }
  writePendingPairs(paths, readPendingPairs(paths).filter((entry) => !samePair(entry, pair)));
  const leaseDirectory = pairLeaseDirectory(paths, pair);
  if (pathExists(leaseDirectory) && !lstatSync(leaseDirectory).isSymbolicLink()
    && lstatSync(leaseDirectory).isDirectory() && readdirSync(leaseDirectory).length === 0) {
    rmSync(leaseDirectory, { recursive: true });
  }
  return "removed";
}

function pruneInstalledPairsLocked(dataRoot) {
  const paths = layout(dataRoot);
  const activation = readActivation(dataRoot);
  const retained = [activation.active, activation.previous, ...readVerifiedPinnedPairs(paths)].filter(Boolean);
  let removed = 0;
  let deferred = 0;
  for (const pair of installedPairs(paths)) {
    if (retained.some((entry) => samePair(entry, pair))) continue;
    const outcome = removeInstalledPairLocked(dataRoot, pair);
    if (outcome === "removed") removed += 1;
    else deferred += 1;
  }
  return { removed, deferred };
}

export function pruneManagedInstallation(dataRoot) {
  return withLifecycleLock(dataRoot, "prune retained releases", () => pruneInstalledPairsLocked(dataRoot));
}

export function removeInstalledPair(dataRoot, pair) {
  return withLifecycleLock(dataRoot, `remove ${pair.downstreamReleaseId}`, () => removeInstalledPairLocked(dataRoot, pair));
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
  assertOutsideSharedPiData(dataRoot, environment);
  const binDirectory = resolve(options.binDirectory || defaultManagedBinDirectory(environment));
  validateBinDirectory(binDirectory);
  const paths = layout(dataRoot);
  const expectedCompatibility = {
    path: join(binDirectory, "pi-wait-for-user"),
    target: join(paths.root, "dispatcher", "managed-dispatcher.mjs"),
  };
  if (pathExists(compatibilityReceiptPath(paths))) {
    requireOwnedCompatibility(paths, expectedCompatibility, { allowMissing: true });
  } else if (pathExists(expectedCompatibility.path)) fail(`Unowned foreign command collision: ${expectedCompatibility.path}`);
  const piPath = join(binDirectory, "pi");
  const ownershipPath = join(paths.state, "entrypoints.json");
  if (pathExists(ownershipPath)) {
    const ownership = readManagedOwnership(dataRoot);
    if (resolve(ownership.entrypoints.pi.path) !== piPath
      || (pathExists(piPath) && !entrypointMatches(ownership.entrypoints.pi))) {
      fail(`Command Ownership pi entrypoint mismatch: ${piPath}`);
    }
  } else if (options.managePi && pathExists(piPath)) fail(`Unowned foreign command collision: ${piPath}`);
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

function validateDispatcherForRemoval(paths, { allowMissingPayload = false } = {}) {
  const destination = join(paths.root, "dispatcher");
  const centralPath = join(paths.state, "dispatcher.json");
  if (!pathExists(destination) && !pathExists(centralPath)) return null;
  if (!pathExists(centralPath)) fail("Inconsistent Managed Dispatcher receipt");
  if (!pathExists(destination)) {
    if (!allowMissingPayload) fail("Inconsistent Managed Dispatcher receipt");
    validateDispatcherReceipt(readJson(centralPath, "Managed Dispatcher receipt"), destination);
    return { destination, centralPath, payloadExists: false };
  }
  if (lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isDirectory()) {
    fail("Inconsistent Managed Dispatcher receipt");
  }
  const embedded = validateDispatcherReceipt(
    readJson(join(destination, ".managed", "receipt.json"), "Managed Dispatcher receipt"),
    destination,
  );
  const central = validateDispatcherReceipt(readJson(centralPath, "Managed Dispatcher receipt"), destination);
  if (canonicalJson(embedded) !== canonicalJson(central)) fail("Managed Dispatcher receipt copies mismatch");
  validateDispatcherPayload(destination, central);
  return { destination, centralPath, payloadExists: true };
}

function validateManagerPayloadsForRemoval(paths, { allowMissingManagerIds = new Set() } = {}) {
  const receiptDirectory = ensureNoSymlinkPath(paths.receipts, join(paths.receipts, "managers"), "Manager receipt directory");
  ensureManagedDirectory(receiptDirectory);
  const found = [];
  for (const name of readdirSync(receiptDirectory).sort()) {
    if (!name.endsWith(".json")) fail(`Foreign Manager Release receipt: ${name}`);
    const managerReleaseId = name.slice(0, -5);
    ensureIdentifier(managerReleaseId, "Manager Release receipt ID");
    const managerPath = join(paths.managers, managerReleaseId);
    const central = readJson(join(receiptDirectory, name), "manager receipt");
    const pair = {
      managerReleaseId,
      downstreamReleaseId: managerReleaseId,
      manifestSha256: central.manifestSha256,
      platform: central.platform,
    };
    if (pathExists(managerPath)) {
      const receipt = readReceiptCopies(paths, "manager", managerReleaseId, managerPath, pair);
      comparePayload(payloadWithoutManagerFiles(managerPath), receipt.payload);
    } else if (allowMissingManagerIds.has(managerReleaseId)) validateReceipt(central, "manager", managerPath, pair);
    else fail(`Inconsistent receipt for Manager Release ${managerReleaseId}`);
    found.push(managerReleaseId);
  }
  for (const managerReleaseId of readdirSync(paths.managers)) {
    ensureIdentifier(managerReleaseId, "installed Manager Release ID");
    if (!found.includes(managerReleaseId)) fail(`Installed Manager Release has no receipt: ${managerReleaseId}`);
  }
}

const managedRootEntries = new Set([
  "state", "managers", "downstream-releases", "receipts", "artifacts", "leases", "tmp", "diagnostics", "dispatcher",
]);

function validateUninstallRoot(root) {
  let hasManagedState = false;
  for (const name of readdirSync(root)) {
    const path = ensureNoSymlinkPath(root, join(root, name), "Managed uninstall root path");
    if (name === "releases") {
      if (!lstatSync(path).isDirectory()) fail("Legacy Downstream Installation root is foreign");
      continue;
    }
    if (!managedRootEntries.has(name)) fail(`Foreign Managed Installation root path: ${name}`);
    hasManagedState = true;
  }
  return hasManagedState;
}

function readUninstallPending(paths) {
  if (!pathExists(paths.uninstallPending)) return null;
  const value = readJson(paths.uninstallPending, "pending uninstall state");
  exactObject(value, "pending uninstall state", ["schemaVersion", "type", "pairs", "createdAt"]);
  if (value.schemaVersion !== 1 || value.type !== "pending-uninstall" || !Array.isArray(value.pairs)) {
    fail("Malformed pending uninstall state");
  }
  value.pairs.forEach((pair) => validatePairShape(pair, "pending uninstall pair"));
  if (value.pairs.some((pair, index) => value.pairs.findIndex((candidate) => samePair(candidate, pair)) !== index)
    || new Set(value.pairs.map((pair) => pair.downstreamReleaseId)).size !== value.pairs.length) {
    fail("Malformed pending uninstall state");
  }
  expectDate(value.createdAt, "pending uninstall creation date");
  return value;
}

function writeUninstallPending(paths, pairs, createdAt = new Date().toISOString(), { preserveEmpty = false } = {}) {
  if (pairs.length === 0 && !preserveEmpty) {
    if (pathExists(paths.uninstallPending)) unlinkSync(paths.uninstallPending);
    return;
  }
  atomicWrite(paths.uninstallPending, { schemaVersion: 1, type: "pending-uninstall", pairs, createdAt });
}

function validatePairLeaseDirectory(paths, pair) {
  const directory = pairLeaseDirectory(paths, pair);
  for (const name of readdirSync(directory)) {
    const path = ensureNoSymlinkPath(directory, join(directory, name), "Pair lease path");
    if (!lstatSync(path).isFile() || !name.endsWith(".json")) fail(`Foreign pair lease path: ${name}`);
    const lease = readJson(path, "pair lease");
    exactObject(lease, "pair lease", ["schemaVersion", "pid", "processStartIdentity", "token", "createdAt"]);
    if (lease.schemaVersion !== 1 || !Number.isSafeInteger(lease.pid) || lease.pid < 1
      || !uuidPattern.test(lease.token) || name !== `${lease.token}.json`
      || (lease.processStartIdentity !== null && (typeof lease.processStartIdentity !== "string" || !lease.processStartIdentity))) {
      fail(`Foreign pair lease path: ${name}`);
    }
    expectDate(lease.createdAt, "pair lease creation date");
  }
}

function validateUninstallReceiptsAndLeases(paths, pairs) {
  const receiptChildren = readdirSync(paths.receipts).sort();
  if (canonicalJson(receiptChildren) !== canonicalJson(["managers", "releases"])) {
    fail("Foreign receipt root path");
  }
  for (const name of receiptChildren) {
    const path = ensureNoSymlinkPath(paths.receipts, join(paths.receipts, name), "Receipt root path");
    if (!lstatSync(path).isDirectory()) fail("Foreign receipt root path");
  }
  const pairDirectories = new Map(pairs.map((pair) => [basename(pairLeaseDirectory(paths, pair)), pair]));
  for (const name of readdirSync(paths.leases)) {
    const directory = ensureNoSymlinkPath(paths.leases, join(paths.leases, name), "Pair lease directory");
    if (!lstatSync(directory).isDirectory()) fail(`Foreign pair lease path: ${name}`);
    const pair = pairDirectories.get(name);
    if (!pair) fail(`Foreign pair lease path: ${name}`);
    livePairLeases(paths, pair, { removeStale: false });
  }
}

function validateUninstallUpdateStatus(value) {
  exactObject(value, "managed update status", ["schemaVersion", "type", "checkedAt", "active", "channel", "compatibleUpdate", "patchLag", "upstream"]);
  if (value.schemaVersion !== 1 || value.type !== "managed-update-status") fail("Malformed managed update status");
  expectDate(value.checkedAt, "managed update status date");
  exactObject(value.active, "managed update active state", ["releaseId", "managerReleaseId", "upstreamVersion", "manifestSha256"]);
  exactObject(value.channel, "managed update Channel state", ["sequence", "releaseId", "manifestSha256"]);
  exactObject(value.upstream, "managed update upstream state", ["observedVersion", "error"]);
  ensureIdentifier(value.active.releaseId, "managed update active release ID");
  ensureIdentifier(value.active.managerReleaseId, "managed update active Manager Release ID");
  ensureIdentifier(value.channel.releaseId, "managed update Channel release ID");
  expectString(value.active.upstreamVersion, "managed update upstream version", semverPattern);
  expectString(value.active.manifestSha256, "managed update active manifest digest", sha256Pattern);
  expectString(value.channel.manifestSha256, "managed update Channel manifest digest", sha256Pattern);
  if (!Number.isSafeInteger(value.channel.sequence) || value.channel.sequence < 1
    || (value.upstream.observedVersion !== null && (typeof value.upstream.observedVersion !== "string" || !semverPattern.test(value.upstream.observedVersion)))
    || (value.upstream.error !== null && (typeof value.upstream.error !== "string" || value.upstream.error.length > 500))) fail("Malformed managed update status");
  if (value.compatibleUpdate !== null) {
    exactObject(value.compatibleUpdate, "compatible update state", ["releaseId", "managerReleaseId", "upstreamVersion", "sequence"]);
    ensureIdentifier(value.compatibleUpdate.releaseId, "compatible update release ID");
    ensureIdentifier(value.compatibleUpdate.managerReleaseId, "compatible update Manager Release ID");
    expectString(value.compatibleUpdate.upstreamVersion, "compatible update upstream version", semverPattern);
    if (!Number.isSafeInteger(value.compatibleUpdate.sequence) || value.compatibleUpdate.sequence < 1
      || value.compatibleUpdate.releaseId !== value.channel.releaseId
      || value.compatibleUpdate.sequence !== value.channel.sequence) fail("Malformed managed update status");
  }
  if (value.patchLag !== null) {
    exactObject(value.patchLag, "Patch Lag state", ["currentReleaseId", "currentUpstreamVersion", "observedUpstreamVersion"]);
    ensureIdentifier(value.patchLag.currentReleaseId, "Patch Lag release ID");
    expectString(value.patchLag.currentUpstreamVersion, "Patch Lag current upstream version", semverPattern);
    expectString(value.patchLag.observedUpstreamVersion, "Patch Lag observed upstream version", semverPattern);
    if (value.patchLag.currentReleaseId !== value.active.releaseId
      || value.patchLag.currentUpstreamVersion !== value.active.upstreamVersion
      || value.patchLag.observedUpstreamVersion !== value.upstream.observedVersion) fail("Malformed managed update status");
  }
  if (value.compatibleUpdate !== null && value.patchLag !== null) fail("Malformed managed update status");
}

function validateUninstallStartupState(name, value) {
  if (name === "startup-check.json") {
    exactObject(value, "startup check state", ["schemaVersion", "type", "lastAttemptAt"]);
    if (value.schemaVersion !== 1 || value.type !== "managed-startup-check") fail("Malformed startup check state");
    expectDate(value.lastAttemptAt, "startup check date");
    return;
  }
  exactObject(value, "startup check lock", ["schemaVersion", "type", "pid", "processStartIdentity", "token", "createdAt"]);
  if (value.schemaVersion !== 1 || value.type !== "managed-startup-check-lock"
    || !Number.isSafeInteger(value.pid) || value.pid < 1 || !uuidPattern.test(value.token)) fail("Malformed startup check lock");
  expectString(value.processStartIdentity, "startup check process identity");
  expectDate(value.createdAt, "startup check lock date");
}

function validateUninstallState(dataRoot, paths, pairs) {
  const known = new Set([
    "activation.json", "accepted-metadata.json", "config.json", "pending-cleanup.json", "pinned-releases.json",
    "uninstall-pending.json", "rollback-transaction.json", "update-hold-clear-transaction.json", "entrypoints.json", "compatibility-entrypoint.json", "legacy-adoption.json", "update-status.json",
    "startup-check.json", "startup-check.lock", "update-hold.json", "dispatcher.json", "lifecycle.lock",
  ]);
  for (const name of readdirSync(paths.state)) {
    const path = ensureNoSymlinkPath(paths.state, join(paths.state, name), "Managed uninstall state path");
    if (!lstatSync(path).isFile()) fail(`Foreign managed state path: ${name}`);
    const dynamicRecovery = /^(?:lifecycle|startup-check)-recovery-[a-z0-9-]+\.(?:json|owner)$/.test(name);
    if (!known.has(name) && !dynamicRecovery) fail(`Foreign managed state path: ${name}`);
    if (dynamicRecovery) {
      const recovery = readJson(path, "lifecycle recovery state");
      const recoveryKeys = {
        "lifecycle-lock-recovery": ["schemaVersion", "type", "staleToken", "claimedByToken", "claimedAt"],
        "lifecycle-lock-recovery-owner": ["schemaVersion", "type", "staleToken", "pid", "processStartIdentity", "claimantToken", "claimedAt"],
        "startup-check-lock-recovery": ["schemaVersion", "type", "staleToken", "claimedAt"],
        "startup-check-recovery-owner": ["schemaVersion", "type", "staleToken", "pid", "processStartIdentity", "token", "claimedAt"],
      };
      const keys = recoveryKeys[recovery.type];
      if (recovery.schemaVersion !== 1 || !keys) fail(`Malformed managed recovery state: ${name}`);
      exactObject(recovery, "managed recovery state", keys);
      expectString(recovery.staleToken, "managed recovery stale token");
      expectDate(recovery.claimedAt, "managed recovery claim date");
      if ("pid" in recovery && (!Number.isSafeInteger(recovery.pid) || recovery.pid < 1)) fail(`Malformed managed recovery state: ${name}`);
      for (const field of ["claimedByToken", "processStartIdentity", "claimantToken", "token"]) {
        if (field in recovery) expectString(recovery[field], `managed recovery ${field}`);
      }
      const expectedName = recovery.type.startsWith("lifecycle-")
        ? `lifecycle-recovery-${digestBytes(String(recovery.staleToken))}.${recovery.type.endsWith("owner") ? "owner" : "json"}`
        : `startup-check-recovery-${recovery.staleToken}.${recovery.type.endsWith("owner") ? "owner" : "json"}`;
      if (name !== expectedName) fail(`Managed recovery state filename mismatch: ${name}`);
    }
  }
  const uninstallPending = readUninstallPending(paths);
  if (pairs.length === 0 && !uninstallPending && pathExists(paths.activation)) {
    fail("Activation exists without receipt-proven local pairs");
  }
  if (pairs.length > 0 && !uninstallPending) {
    const activation = readActivation(dataRoot);
    readConfig(paths);
    if (!readAcceptedMetadataState(paths)) fail("Accepted metadata state is missing for existing Activation");
    for (const selected of [activation.active, activation.previous].filter(Boolean)) {
      if (!pairs.some((pair) => samePair(pair, selected))) {
        fail("Activation selects an unreceipted local pair");
      }
    }
  }
  if (uninstallPending) {
    for (const pending of uninstallPending.pairs) {
      const installed = pairs.some((pair) => samePair(pair, pending));
      const payloadExists = pathExists(join(paths.releases, pending.downstreamReleaseId));
      const receiptExists = pathExists(receiptPath(paths, "downstream", pending.downstreamReleaseId));
      if (!installed && (payloadExists || receiptExists)) fail("Pending uninstall pair identity mismatch");
    }
  }
  readPendingPairs(paths);
  const pins = uninstallPending ? readPinnedPairs(paths) : readVerifiedPinnedPairs(paths);
  if (uninstallPending) {
    for (const pin of pins) {
      const installed = pairs.find((pair) => pair.downstreamReleaseId === pin.downstreamReleaseId);
      const pending = uninstallPending.pairs.some((pair) => samePair(pair, pin));
      if ((installed && !samePair(installed, pin)) || (!installed && !pending)) {
        fail(`Pinned Release identity mismatch: ${pin.downstreamReleaseId}`);
      }
    }
  }
  readRollbackTransaction(paths);
  readUpdateHoldClearTransaction(paths);
  readUpdateHoldRecord(paths);
  if (pathExists(join(paths.state, "legacy-adoption.json"))) readLegacyInstallationAdoption(dataRoot);
  const statusPath = join(paths.state, "update-status.json");
  if (pathExists(statusPath)) validateUninstallUpdateStatus(readJson(statusPath, "managed update status"));
  for (const name of ["startup-check.json", "startup-check.lock"]) {
    const path = join(paths.state, name);
    if (pathExists(path)) validateUninstallStartupState(name, readJson(path, `managed ${name}`));
  }
}

function validateUninstallCaches(paths, pairs, dispatcher) {
  for (const name of readdirSync(paths.artifacts)) {
    if (!sha256Pattern.test(name)) fail(`Foreign cached artifact: ${name}`);
    const path = ensureNoSymlinkPath(paths.artifacts, join(paths.artifacts, name), "Cached artifact path");
    const stat = lstatSync(path);
    if (!stat.isFile() || sha256File(path) !== name) fail(`Cached artifact ownership mismatch: ${name}`);
  }
  for (const name of readdirSync(paths.diagnostics)) {
    if (!isManagedDiagnostic(paths, name)) fail(`Foreign diagnostic path: ${name}`);
  }
  for (const name of readdirSync(paths.temporary)) {
    const path = ensureNoSymlinkPath(paths.temporary, join(paths.temporary, name), "Temporary uninstall path");
    if (!safeTemporaryOwner(path)) fail(`Foreign temporary path: ${name}`);
    const owner = readJson(join(path, ".owner.json"), "temporary receipt");
    if (owner.type === "managed-tombstone") {
      const expected = owner.scope.kind === "dispatcher"
        ? dispatcher && metadataDigest(readJson(dispatcher.centralPath, "Managed Dispatcher receipt"))
        : pairs.some((pair) => owner.scope.identity === metadataDigest({ kind: owner.scope.kind, pair }));
      if (owner.scope.kind === "dispatcher" ? owner.scope.identity !== expected : !expected) {
        fail(`Tombstone identity mismatch: ${name}`);
      }
    }
  }
}

function removeOwnedEntrypoint(entrypoint, label) {
  if (!pathExists(entrypoint.path)) return false;
  if (!entrypointMatches(entrypoint)) fail(`${label} ownership mismatch: ${entrypoint.path}`);
  unlinkSync(entrypoint.path);
  return true;
}

function finalPiResolution(environment, operation = "uninstall") {
  const resolved = commandPath("pi", environment);
  if (!resolved) return { kind: "none", message: `No pi command will resolve after ${operation}.` };
  if (isManagedDispatcherExecutable(resolved)) fail(`Managed Dispatcher still resolves after ${operation}: ${resolved}`);
  try {
    const identity = executableIdentity(resolved, environment);
    return { kind: "stock", path: resolved, version: identity.version, message: `Stock Pi ${identity.version} at ${resolved} will resolve after ${operation}.` };
  } catch {
    return { kind: "stock", path: resolved, version: null, message: `Stock Pi at ${resolved} will resolve after ${operation} (its version identity is unavailable).` };
  }
}

export function managedPiResolution(environment = process.env, operation = "disable") {
  return finalPiResolution(environment, operation);
}

export function uninstallManagedInstallation(dataRoot, options = {}) {
  const root = resolve(dataRoot);
  const environment = options.environment || process.env;
  assertOutsideSharedPiData(root, environment);
  if (!pathExists(root)) return { kind: "already-absent", deferred: 0, resolution: finalPiResolution(environment) };
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) fail(`Managed state path is foreign: ${root}`);
  if (!validateUninstallRoot(root)) return { kind: "already-absent", deferred: 0, resolution: finalPiResolution(environment) };
  return withLifecycleLock(dataRoot, "uninstall Managed Installation", () => {
    const paths = initializeLayout(dataRoot);
    const pendingUninstall = readUninstallPending(paths);
    const pendingPairs = pendingUninstall?.pairs || [];
    const installed = installedPairs(paths, { allowMissingPairs: pendingPairs });
    const pendingWithOwnedState = pendingPairs.filter((pair) => [
      join(paths.releases, pair.downstreamReleaseId),
      receiptPath(paths, "downstream", pair.downstreamReleaseId),
      join(paths.managers, pair.managerReleaseId),
      receiptPath(paths, "manager", pair.managerReleaseId),
      pairLeaseDirectory(paths, pair),
    ].some((path) => pathExists(path)));
    const pairs = [...installed, ...pendingWithOwnedState]
      .filter((pair, index, all) => all.findIndex((candidate) => samePair(candidate, pair)) === index);
    validateManagerPayloadsForRemoval(paths, { allowMissingManagerIds: new Set(pendingPairs.map((pair) => pair.managerReleaseId)) });
    validateUninstallState(dataRoot, paths, pairs);
    validateUninstallReceiptsAndLeases(paths, pairs);
    const dispatcher = validateDispatcherForRemoval(paths, { allowMissingPayload: Boolean(pendingUninstall) });
    validateUninstallCaches(paths, pairs, dispatcher);
    const ownershipPath = join(paths.state, "entrypoints.json");
    const compatibilityPath = compatibilityReceiptPath(paths);
    const ownership = pathExists(ownershipPath) ? readManagedOwnership(dataRoot) : null;
    const compatibility = pathExists(compatibilityPath) ? readCompatibilityEntrypoint(paths) : null;
    if (ownership) {
      if (dispatcher?.payloadExists) assertDispatcherIdentity(ownership.dispatcher);
      else if (!pendingUninstall) fail("Managed Dispatcher identity is missing");
      if (compatibility && (resolve(compatibility.path) !== resolve(ownership.entrypoints.compatibility.path)
        || resolve(compatibility.target) !== resolve(ownership.entrypoints.compatibility.target))) {
        fail("Compatibility Entrypoint receipt copies mismatch");
      }
      if (pathExists(ownership.entrypoints.pi.path) && !entrypointMatches(ownership.entrypoints.pi)) {
        fail(`Command Ownership pi entrypoint mismatch: ${ownership.entrypoints.pi.path}`);
      }
      if (pathExists(ownership.entrypoints.compatibility.path) && !entrypointMatches(ownership.entrypoints.compatibility)) {
        fail(`Compatibility Entrypoint ownership mismatch: ${ownership.entrypoints.compatibility.path}`);
      }
    }
    if (compatibility && pathExists(compatibility.path) && !entrypointMatches(compatibility)) {
      fail(`Compatibility Entrypoint ownership mismatch: ${compatibility.path}`);
    }
    const pendingCreatedAt = readUninstallPending(paths)?.createdAt;
    writeUninstallPending(paths, pairs, pendingCreatedAt);
    options.checkpoint?.("uninstall-preflight-complete");

    if (ownership) removeOwnedEntrypoint(ownership.entrypoints.pi, "Command Ownership pi entrypoint");
    options.checkpoint?.("uninstall-pi-entrypoint-removed");
    if (compatibility) removeOwnedEntrypoint(compatibility, "Compatibility Entrypoint");
    else if (ownership) removeOwnedEntrypoint(ownership.entrypoints.compatibility, "Compatibility Entrypoint");
    options.checkpoint?.("uninstall-compatibility-entrypoint-removed");

    let deferred = 0;
    for (const pair of pairs) {
      if (removeInstalledPairLocked(dataRoot, pair, {
        mode: "uninstall",
        checkpoint: options.checkpoint,
      }) === "deferred") deferred += 1;
      writeUninstallPending(paths, installedPairs(paths, { allowMissingPairs: pairs }), pendingCreatedAt, { preserveEmpty: true });
    }
    options.checkpoint?.("uninstall-payloads-removed");

    if (dispatcher) {
      if (dispatcher.payloadExists) {
        removeThroughTombstone(
          paths,
          dispatcher.destination,
          "dispatcher",
          metadataDigest(readJson(dispatcher.centralPath, "Managed Dispatcher receipt")),
          options.checkpoint,
          "uninstall-dispatcher",
        );
        options.checkpoint?.("uninstall-dispatcher-payload-removed");
      }
      unlinkSync(dispatcher.centralPath);
      options.checkpoint?.("uninstall-dispatcher-receipt-removed");
    }
    if (pathExists(ownershipPath)) unlinkSync(ownershipPath);
    if (pathExists(compatibilityPath)) unlinkSync(compatibilityPath);
    for (const name of readdirSync(paths.artifacts)) unlinkSync(join(paths.artifacts, name));
    for (const name of readdirSync(paths.diagnostics)) unlinkSync(join(paths.diagnostics, name));
    for (const name of readdirSync(paths.temporary)) removeStage(join(paths.temporary, name));
    for (const stateName of [
      "activation.json", "accepted-metadata.json", "config.json", "pending-cleanup.json", "legacy-adoption.json",
      "pinned-releases.json", "rollback-transaction.json", "update-hold-clear-transaction.json", "update-status.json", "startup-check.json", "startup-check.lock", "update-hold.json",
    ]) {
      const path = join(paths.state, stateName);
      if (pathExists(path)) unlinkSync(path);
    }
    options.checkpoint?.("uninstall-state-removed");

    const remainingPairs = installedPairs(paths, { allowMissingPairs: pairs });
    writeUninstallPending(paths, remainingPairs, pendingCreatedAt);
    if (remainingPairs.length === 0) {
      for (const name of managedRootEntries) {
        const path = join(root, name);
        if (!pathExists(path)) continue;
        makeWritable(path);
        rmSync(path, { recursive: true, force: true });
      }
      if (readdirSync(root).length === 0) rmSync(root, { recursive: true });
    }
    const resolution = finalPiResolution(environment);
    return { kind: "uninstalled", deferred, resolution };
  });
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
