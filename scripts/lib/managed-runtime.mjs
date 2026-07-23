import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

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
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`Malformed ${label}`);
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

function layout(dataRoot) {
  const root = resolve(dataRoot);
  return {
    root,
    state: join(root, "state"),
    activation: join(root, "state", "activation.json"),
    accepted: join(root, "state", "accepted-metadata.json"),
    config: join(root, "state", "config.json"),
    managers: join(root, "managers"),
    releases: join(root, "releases"),
    receipts: join(root, "receipts"),
    artifacts: join(root, "artifacts"),
    leases: join(root, "leases"),
    temporary: join(root, "tmp"),
    diagnostics: join(root, "diagnostics"),
    pending: join(root, "state", "pending-cleanup.json"),
    lock: join(root, "state", "lifecycle.lock"),
  };
}

function initializeLayout(dataRoot) {
  const paths = layout(dataRoot);
  for (const path of [paths.root, paths.state, paths.managers, paths.releases, paths.receipts, paths.artifacts, paths.leases, paths.temporary, paths.diagnostics]) {
    ensureManagedDirectory(path);
  }
  return paths;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function withLifecycleLock(dataRoot, operation, callback) {
  expectString(operation, "lifecycle operation");
  const paths = initializeLayout(dataRoot);
  const token = randomUUID();
  const lock = { schemaVersion: 1, pid: process.pid, token, operation, startedAt: new Date().toISOString() };
  let fd;
  try {
    fd = openSync(paths.lock, "wx", 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const active = readJson(paths.lock, "lifecycle lock");
    exactObject(active, "lifecycle lock", ["schemaVersion", "pid", "token", "operation", "startedAt"]);
    if (Number.isSafeInteger(active.pid) && active.pid > 0 && processAlive(active.pid)) {
      fail(`Managed lifecycle operation already active: ${String(active.operation)}`);
    }
    unlinkSync(paths.lock);
    fd = openSync(paths.lock, "wx", 0o600);
  }
  writeSync(fd, serializeMetadata(lock));
  fsyncSync(fd);
  closeSync(fd);
  try {
    return callback();
  } finally {
    try {
      const current = readJson(paths.lock, "lifecycle lock");
      if (current.token === token) unlinkSync(paths.lock);
    } catch {
      // Never remove a lock that no longer proves this operation owns it.
    }
  }
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
    if (canonicalJson(existingReceipt.sourceArtifact) !== canonicalJson(receipt.sourceArtifact)
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
  atomicWrite(
    receiptPath(paths, receipt.type, receipt.type === "manager" ? receipt.managerReleaseId : receipt.downstreamReleaseId),
    publishedReceipt,
  );
  checkpoint?.(boundary);
}

function writeConfig(paths, platform, rootKeys) {
  const config = {
    schemaVersion: 1,
    platform,
    rootKeys: [...rootKeys].map(([keyId, publicKey]) => ({ keyId, publicKey })).sort((a, b) => a.keyId.localeCompare(b.keyId)),
  };
  if (existsSync(paths.config)) {
    const existing = readJson(paths.config, "managed configuration");
    if (canonicalJson(existing) !== canonicalJson(config)) fail("Managed root trust or platform configuration mismatch");
  } else atomicWrite(paths.config, config);
}

function readConfig(paths) {
  const config = readJson(paths.config, "managed configuration");
  exactObject(config, "managed configuration", ["schemaVersion", "platform", "rootKeys"]);
  if (config.schemaVersion !== 1 || !Array.isArray(config.rootKeys) || config.rootKeys.length === 0) fail("Malformed managed configuration");
  ensurePlatform(config.platform);
  const rootKeys = new Map();
  for (const entry of config.rootKeys) {
    exactObject(entry, "managed root key", ["keyId", "publicKey"]);
    expectString(entry.keyId, "managed root key ID");
    expectString(entry.publicKey, "managed root public key");
    if (rootKeys.has(entry.keyId)) fail("Malformed managed configuration");
    rootKeys.set(entry.keyId, entry.publicKey);
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
  const activation = readJson(paths.activation, "Activation");
  exactObject(activation, "Activation", ["schemaVersion", "type", "createdAt", "active", "previous"]);
  if (activation.schemaVersion !== 1 || activation.type !== "activation") fail("Malformed Activation");
  expectDate(activation.createdAt, "Activation creation date");
  validatePairShape(activation.active, "active Activation pair");
  if (activation.previous !== null) validatePairShape(activation.previous, "previous Activation pair");
  return activation;
}

function readReceiptCopies(paths, type, id, ownedPath, pair) {
  const central = validateReceipt(readJson(receiptPath(paths, type, id), `${type} receipt`), type, ownedPath, pair);
  const embedded = validateReceipt(readJson(join(ownedPath, ".managed", "receipt.json"), `${type} receipt`), type, ownedPath, pair);
  if (canonicalJson(central) !== canonicalJson(embedded)) fail(`${type} receipt copies mismatch`);
  return central;
}

export function validateActivePair(dataRoot, pair = readActivation(dataRoot).active) {
  const paths = layout(dataRoot);
  const config = readConfig(paths);
  validatePairShape(pair, "Activation pair");
  if (pair.platform !== config.platform) fail("Activation platform mismatch");
  const managerPath = ensureNoSymlinkPath(paths.managers, join(paths.managers, pair.managerReleaseId), "Manager Release path");
  const releasePath = ensureNoSymlinkPath(paths.releases, join(paths.releases, pair.downstreamReleaseId), "Downstream Release path");
  if (!lstatSync(managerPath).isDirectory() || !lstatSync(releasePath).isDirectory()) fail("Activation payload directory is missing");
  const managerReceipt = readReceiptCopies(paths, "manager", pair.managerReleaseId, managerPath, pair);
  const releaseReceipt = readReceiptCopies(paths, "downstream", pair.downstreamReleaseId, releasePath, pair);
  if (releaseReceipt.manifestSha256 !== pair.manifestSha256) fail("Activation manifest identity mismatch");
  const managerExecutable = join(managerPath, "package", "manager");
  const pi = join(releasePath, "pi-wait-for-user", "pi-core");
  const question = join(releasePath, "pi-wait-for-user", "question-tool", "extensions", "question-tool.ts");
  const releaseMetadata = join(releasePath, "pi-wait-for-user", "release.json");
  const manifest = join(releasePath, ".managed", "release-manifest.json");
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
  validateArtifactBytes(join(selected.paths.artifacts, managerArtifact.sha256), managerArtifact, "Cached Manager Release");
  validateArtifactBytes(join(selected.paths.artifacts, downstream.artifact.sha256), downstream.artifact, "Cached Downstream Release");
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
    if (sha256File(destination) !== expected.sha256 || statSync(destination).size !== expected.size) fail("Cached artifact identity mismatch");
    return;
  }
  const temporary = `${destination}.tmp-${randomUUID()}`;
  copyFileSync(source, temporary);
  chmodSync(temporary, 0o444);
  renameSync(temporary, destination);
}

function diagnostic(paths, error) {
  try {
    atomicWrite(join(paths.diagnostics, `${Date.now()}-${randomUUID()}.json`), {
      schemaVersion: 1,
      type: "activation-failure",
      recordedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // A diagnostic must never mask the original verification failure.
  }
}

export function installAndActivate(options) {
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
  } = options;
  ensurePlatform(platform);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("Invalid activation verification date");
  if (!(rootKeys instanceof Map) || rootKeys.size === 0) fail("No pinned root keys configured");
  return withLifecycleLock(dataRoot, `activate ${manifestEnvelope?.signed?.releaseId ?? "candidate"}`, () => {
    const paths = initializeLayout(dataRoot);
    let managerStage;
    let releaseStage;
    try {
      writeConfig(paths, platform, rootKeys);
      const accepted = existsSync(paths.accepted) ? readJson(paths.accepted, "accepted metadata state") : undefined;
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

      managerStage = createStage(paths, "manager");
      extractArchive(managerArchive, managerStage.payload);
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
      extractArchive(releaseArchive, releaseStage.payload);
      comparePayload(payloadWithoutManagerFiles(releaseStage.payload), downstream.payload);
      validateQuestionTool(releaseStage.payload, manifest);
      const core = join(releaseStage.payload, "pi-wait-for-user", "pi-core");
      runChecked(core, ["--version"], "Pi reported version", manifest.upstream.packageVersion);
      runChecked(core, ["--help"], "Pi smoke check");
      const conformance = runChecked(core, ["conformance"], "Pi conformance");
      if (!/conformance passed/i.test(conformance)) fail("Pi conformance did not report success");
      checkpoint?.("downstream-staged");

      atomicWrite(paths.accepted, { schemaVersion: 1, trust: authority.acceptedState, channel: selection });
      checkpoint?.("metadata-accepted");
      saveArtifact(paths, managerArchive, managerArtifact);
      saveArtifact(paths, releaseArchive, downstream.artifact);

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
        if (canonicalJson(current.active) === canonicalJson(pair)) return current;
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
      checkpoint?.("after-activation-switch");
      return activation;
    } catch (error) {
      if (managerStage) removeStage(managerStage.stage);
      if (releaseStage) removeStage(releaseStage.stage);
      diagnostic(paths, error);
      throw error;
    }
  });
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
      exactObject(lease, "pair lease", ["schemaVersion", "pid", "token", "createdAt"]);
      if (lease.schemaVersion !== 1 || !Number.isSafeInteger(lease.pid) || lease.pid < 1) fail("Malformed pair lease");
      expectString(lease.token, "pair lease token");
      expectDate(lease.createdAt, "pair lease creation date");
    } catch {
      live.push(path); // Ambiguous lease state must defer deletion.
      continue;
    }
    if (processAlive(lease.pid)) live.push(path);
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
  const lease = { schemaVersion: 1, pid: process.pid, token, createdAt: new Date().toISOString() };
  writeFileSync(path, serializeMetadata(lease), { flag: "wx", mode: 0o600 });
  return {
    transfer(pid) {
      if (!Number.isSafeInteger(pid) || pid < 1) fail("Invalid pair lease process");
      atomicWrite(path, { ...lease, pid });
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
    if (existsSync(releasePath)) {
      readReceiptCopies(paths, "downstream", pair.downstreamReleaseId, releasePath, pair);
      removeThroughTombstone(paths, releasePath, "downstream");
      unlinkSync(receiptPath(paths, "downstream", pair.downstreamReleaseId));
    }

    const retainedManager = [activation.active, activation.previous]
      .filter(Boolean)
      .some((entry) => entry.managerReleaseId === pair.managerReleaseId);
    const releaseReceipts = join(paths.receipts, "releases");
    const installedManagerReference = existsSync(releaseReceipts) && readdirSync(releaseReceipts).some((name) => {
      const receipt = readJson(join(releaseReceipts, name), "downstream receipt");
      return receipt.managerReleaseId === pair.managerReleaseId;
    });
    const managerPath = join(paths.managers, pair.managerReleaseId);
    if (!retainedManager && !installedManagerReference && existsSync(managerPath)) {
      readReceiptCopies(paths, "manager", pair.managerReleaseId, managerPath, pair);
      removeThroughTombstone(paths, managerPath, "manager");
      unlinkSync(receiptPath(paths, "manager", pair.managerReleaseId));
    }
    writePendingPairs(paths, readPendingPairs(paths).filter((entry) => canonicalJson(entry) !== canonicalJson(pair)));
    return "removed";
  });
}

export function disableManagedEntrypoint(dataRoot) {
  const paths = initializeLayout(dataRoot);
  const ownershipPath = join(paths.state, "entrypoints.json");
  if (!existsSync(ownershipPath)) return "already disabled";
  return withLifecycleLock(dataRoot, "disable managed command ownership", () => {
    const ownership = readJson(ownershipPath, "managed entrypoint receipt");
    exactObject(ownership, "managed entrypoint receipt", ["schemaVersion", "type", "path", "target"]);
    if (ownership.schemaVersion !== 1 || ownership.type !== "managed-pi-entrypoint") fail("Malformed managed entrypoint receipt");
    const path = resolve(ownership.path);
    if (!existsSync(path)) return "already disabled";
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink() || resolve(dirname(path), readlinkSync(path)) !== resolve(ownership.target)) fail("Managed pi entrypoint ownership mismatch");
    unlinkSync(path);
    return "disabled";
  });
}
