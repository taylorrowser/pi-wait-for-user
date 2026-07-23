import { createHash, sign, verify } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

const sha256Pattern = /^[a-f0-9]{64}$/;
const releaseIdPattern = /^[a-z0-9][a-z0-9.-]+$/;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]+$/;

function fail(message) {
  throw new Error(message);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function expectObject(value, label, keys) {
  if (!plainObject(value)) fail(`Malformed ${label}: expected an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`Malformed ${label}: expected fields ${expected.join(", ")}`);
  }
  return value;
}

function expectString(value, label, pattern) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    fail(`Malformed ${label}`);
  }
  return value;
}

function expectInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`Malformed ${label}`);
  return value;
}

function expectArray(value, label, validate, { minimum = 1 } = {}) {
  if (!Array.isArray(value) || value.length < minimum) fail(`Malformed ${label}`);
  value.forEach((entry, index) => validate(entry, `${label}[${index}]`));
  return value;
}

function expectUnique(values, label, identity = (value) => value) {
  const identities = values.map(identity);
  if (new Set(identities).size !== identities.length) fail(`Malformed ${label}: duplicate values`);
}

function expectDate(value, label) {
  expectString(value, label);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(`Malformed ${label}`);
  return parsed;
}

function expectRelativePath(value, label) {
  expectString(value, label);
  if (value.includes("\\") || posix.isAbsolute(value) || value === "." || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail(`Malformed ${label}`);
  }
  return value;
}

function expectUrl(value, label) {
  expectString(value, label);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`Malformed ${label}`);
  }
  if (url.protocol !== "https:") fail(`Malformed ${label}: HTTPS is required`);
  return value;
}

function validateArtifact(value, label) {
  expectObject(value, label, ["name", "sha256", "size"]);
  expectRelativePath(value.name, `${label}.name`);
  expectString(value.sha256, `${label}.sha256`, sha256Pattern);
  expectInteger(value.size, `${label}.size`);
}

function validateSignature(value, label) {
  expectObject(value, label, ["keyId", "algorithm", "signature"]);
  expectString(value.keyId, `${label}.keyId`, keyIdPattern);
  if (value.algorithm !== "ed25519") fail(`Malformed ${label}.algorithm`);
  expectString(value.signature, `${label}.signature`, /^[A-Za-z0-9+/]+={0,2}$/);
}

function validateEnvelope(value, type) {
  try {
    expectObject(value, `${type} metadata`, ["signed", "signatures"]);
    if (!plainObject(value.signed)) fail(`Malformed ${type} metadata`);
    if (value.signed.schemaVersion !== 1) {
      if (Number.isSafeInteger(value.signed.schemaVersion)) {
        fail(`Unknown ${type} schema version ${value.signed.schemaVersion}`);
      }
      fail(`Malformed ${type} metadata`);
    }
    if (value.signed.type !== type) fail(`Malformed ${type} metadata`);
    expectArray(value.signatures, `${type} signatures`, validateSignature);
    expectUnique(value.signatures, `${type} signatures`, (entry) => entry.keyId);
  } catch (error) {
    if (error instanceof Error && (/^Unknown /.test(error.message) || error.message.startsWith("Malformed "))) throw error;
    fail(`Malformed ${type} metadata`);
  }
}

function validateTrust(value) {
  validateEnvelope(value, "release-trust");
  const signed = expectObject(value.signed, "release-trust payload", [
    "schemaVersion", "type", "version", "expires", "channelUrl", "releaseKeys",
  ]);
  expectInteger(signed.version, "release-trust.version", 1);
  expectDate(signed.expires, "release-trust.expires");
  expectUrl(signed.channelUrl, "release-trust.channelUrl");
  expectArray(signed.releaseKeys, "release-trust.releaseKeys", (entry, label) => {
    expectObject(entry, label, ["keyId", "algorithm", "publicKey", "expires", "revoked"]);
    expectString(entry.keyId, `${label}.keyId`, keyIdPattern);
    if (entry.algorithm !== "ed25519") fail(`Malformed ${label}.algorithm`);
    expectString(entry.publicKey, `${label}.publicKey`);
    expectDate(entry.expires, `${label}.expires`);
    if (typeof entry.revoked !== "boolean") fail(`Malformed ${label}.revoked`);
  });
  expectUnique(signed.releaseKeys, "release-trust.releaseKeys", (entry) => entry.keyId);
}

function validateUpstream(value, label) {
  expectObject(value, label, ["repository", "tag", "commit", "packageVersion"]);
  expectUrl(value.repository, `${label}.repository`);
  expectString(value.tag, `${label}.tag`);
  expectString(value.commit, `${label}.commit`, /^[a-f0-9]{40}$/);
  expectString(value.packageVersion, `${label}.packageVersion`, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/);
}

function validateCompatibility(value, label) {
  expectObject(value, label, ["questionTool", "sessions"]);
  const question = expectObject(value.questionTool, `${label}.questionTool`, [
    "name", "version", "manifest", "package", "coreProtocolVersions", "handlerId", "handlerVersion", "packageSchemaVersions",
  ]);
  expectString(question.name, `${label}.questionTool.name`);
  expectString(question.version, `${label}.questionTool.version`);
  validateArtifact(question.manifest, `${label}.questionTool.manifest`);
  validateArtifact(question.package, `${label}.questionTool.package`);
  expectArray(question.coreProtocolVersions, `${label}.questionTool.coreProtocolVersions`, (entry, itemLabel) => expectInteger(entry, itemLabel, 1));
  expectString(question.handlerId, `${label}.questionTool.handlerId`);
  expectInteger(question.handlerVersion, `${label}.questionTool.handlerVersion`, 1);
  expectArray(question.packageSchemaVersions, `${label}.questionTool.packageSchemaVersions`, (entry, itemLabel) => expectInteger(entry, itemLabel, 1));

  const sessions = expectObject(value.sessions, `${label}.sessions`, [
    "identities", "readableCoreProtocolVersions", "readableHandlers",
  ]);
  expectArray(sessions.identities, `${label}.sessions.identities`, (entry, itemLabel) => {
    expectObject(entry, itemLabel, ["id", "version"]);
    expectString(entry.id, `${itemLabel}.id`);
    expectInteger(entry.version, `${itemLabel}.version`, 1);
  });
  expectArray(sessions.readableCoreProtocolVersions, `${label}.sessions.readableCoreProtocolVersions`, (entry, itemLabel) => expectInteger(entry, itemLabel, 1));
  expectArray(sessions.readableHandlers, `${label}.sessions.readableHandlers`, (entry, itemLabel) => {
    expectObject(entry, itemLabel, ["id", "versions"]);
    expectString(entry.id, `${itemLabel}.id`);
    expectArray(entry.versions, `${itemLabel}.versions`, (version, versionLabel) => expectInteger(version, versionLabel, 1));
  });
}

function validateReleaseManifestEnvelope(value) {
  validateEnvelope(value, "release-manifest");
  const signed = expectObject(value.signed, "release-manifest payload", [
    "schemaVersion", "type", "releaseId", "tag", "publishedAt", "upstream", "patches", "compatibility",
    "manager", "bootstrap", "platformArchives", "releaseGates", "provenance", "releaseNotes",
  ]);
  expectString(signed.releaseId, "release-manifest.releaseId", releaseIdPattern);
  expectString(signed.tag, "release-manifest.tag", releaseIdPattern);
  if (signed.releaseId !== signed.tag) fail("Malformed release-manifest: tag must equal releaseId");
  expectDate(signed.publishedAt, "release-manifest.publishedAt");
  validateUpstream(signed.upstream, "release-manifest.upstream");
  expectArray(signed.patches, "release-manifest.patches", (entry, label) => {
    expectObject(entry, label, ["order", "path", "sha256", "size"]);
    expectInteger(entry.order, `${label}.order`, 1);
    expectRelativePath(entry.path, `${label}.path`);
    expectString(entry.sha256, `${label}.sha256`, sha256Pattern);
    expectInteger(entry.size, `${label}.size`);
  });
  signed.patches.forEach((patch, index) => {
    if (patch.order !== index + 1) fail("Malformed release-manifest.patches: order must be contiguous");
  });
  expectUnique(signed.patches, "release-manifest.patches", (entry) => entry.path);
  validateCompatibility(signed.compatibility, "release-manifest.compatibility");

  const manager = expectObject(signed.manager, "release-manifest.manager", [
    "releaseId", "compatibleReleaseManifestVersions", "artifacts",
  ]);
  expectString(manager.releaseId, "release-manifest.manager.releaseId", releaseIdPattern);
  expectArray(manager.compatibleReleaseManifestVersions, "release-manifest.manager.compatibleReleaseManifestVersions", (entry, label) => expectInteger(entry, label, 1));
  if (!manager.compatibleReleaseManifestVersions.includes(1)) fail("Malformed release-manifest.manager compatibility");
  expectArray(manager.artifacts, "release-manifest.manager.artifacts", validateArtifact);

  const bootstrap = expectObject(signed.bootstrap, "release-manifest.bootstrap", ["installer"]);
  validateArtifact(bootstrap.installer, "release-manifest.bootstrap.installer");

  expectArray(signed.platformArchives, "release-manifest.platformArchives", (entry, label) => {
    expectObject(entry, label, ["platform", "artifact", "payload"]);
    expectString(entry.platform, `${label}.platform`, /^[a-z0-9]+-(?:arm64|x64)$/);
    validateArtifact(entry.artifact, `${label}.artifact`);
    expectArray(entry.payload, `${label}.payload`, (file, fileLabel) => {
      expectObject(file, fileLabel, ["path", "sha256", "size", "mode"]);
      expectRelativePath(file.path, `${fileLabel}.path`);
      expectString(file.sha256, `${fileLabel}.sha256`, sha256Pattern);
      expectInteger(file.size, `${fileLabel}.size`);
      expectInteger(file.mode, `${fileLabel}.mode`);
      if (file.mode > 0o777) fail(`Malformed ${fileLabel}.mode`);
    });
    expectUnique(entry.payload, `${label}.payload`, (file) => file.path);
  });
  expectUnique(signed.platformArchives, "release-manifest.platformArchives", (entry) => entry.platform);

  expectArray(signed.releaseGates, "release-manifest.releaseGates", (entry, label) => {
    expectObject(entry, label, ["name", "status", "definition", "report"]);
    expectString(entry.name, `${label}.name`);
    if (entry.status !== "passed") fail(`Malformed ${label}.status: required release gate did not pass`);
    validateArtifact(entry.definition, `${label}.definition`);
    validateArtifact(entry.report, `${label}.report`);
  });

  const provenance = expectObject(signed.provenance, "release-manifest.provenance", [
    "repository", "workflow", "sourceCommit", "artifacts",
  ]);
  expectString(provenance.repository, "release-manifest.provenance.repository", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  expectRelativePath(provenance.workflow, "release-manifest.provenance.workflow");
  expectString(provenance.sourceCommit, "release-manifest.provenance.sourceCommit", /^[a-f0-9]{40}$/);
  expectArray(provenance.artifacts, "release-manifest.provenance.artifacts", (entry, label) => {
    expectObject(entry, label, ["name", "sha256"]);
    expectRelativePath(entry.name, `${label}.name`);
    expectString(entry.sha256, `${label}.sha256`, sha256Pattern);
  });
  expectUnique(provenance.artifacts, "release-manifest.provenance.artifacts", (entry) => entry.name);
  validateArtifact(signed.releaseNotes, "release-manifest.releaseNotes");

  const expectedProvenance = releaseArtifacts(signed).map(({ name, sha256 }) => ({ name, sha256 }));
  if (canonicalJson(provenance.artifacts) !== canonicalJson(expectedProvenance)) {
    fail("Malformed release-manifest.provenance: every release artifact must be recorded");
  }
}

function validateChannel(value) {
  validateEnvelope(value, "release-channel");
  const signed = expectObject(value.signed, "release-channel payload", [
    "schemaVersion", "type", "sequence", "expires", "manifest",
  ]);
  expectInteger(signed.sequence, "release-channel.sequence", 1);
  expectDate(signed.expires, "release-channel.expires");
  expectObject(signed.manifest, "release-channel.manifest", ["releaseId", "url", "sha256"]);
  expectString(signed.manifest.releaseId, "release-channel.manifest.releaseId", releaseIdPattern);
  expectUrl(signed.manifest.url, "release-channel.manifest.url");
  expectString(signed.manifest.sha256, "release-channel.manifest.sha256", sha256Pattern);
}

function signaturePayload(signed) {
  return Buffer.from(canonicalJson(signed));
}

function envelopeDigest(envelope) {
  return createHash("sha256").update(canonicalJson(envelope)).digest("hex");
}

function verifyAtLeastOneSignature(envelope, keys, unauthorizedMessage) {
  let recognized = false;
  for (const signature of envelope.signatures) {
    const key = keys.get(signature.keyId);
    if (!key) continue;
    recognized = true;
    let valid = false;
    try {
      valid = verify(null, signaturePayload(envelope.signed), key, Buffer.from(signature.signature, "base64"));
    } catch {
      valid = false;
    }
    if (valid) return signature.keyId;
  }
  if (!recognized) fail(unauthorizedMessage);
  fail(`Invalid ${envelope.signed.type} signature`);
}

function verifyDelegated(envelope, trust, now) {
  const signatureKeyIds = envelope.signatures.map((entry) => entry.keyId);
  const delegated = signatureKeyIds.map((keyId) => trust.releaseKeys.get(keyId)).find(Boolean);
  if (!delegated) fail("Signing key is not authorized by release trust");
  if (delegated.revoked) fail(`Release key revoked: ${delegated.keyId}`);
  if (Date.parse(delegated.expires) <= now.getTime()) fail(`Release key expired: ${delegated.keyId}`);
  return verifyAtLeastOneSignature(envelope, new Map([[delegated.keyId, delegated.publicKey]]), "Signing key is not authorized by release trust");
}

function releaseArtifacts(manifest) {
  return [
    ...manifest.manager.artifacts,
    manifest.compatibility.questionTool.package,
    manifest.bootstrap.installer,
    ...manifest.platformArchives.map((entry) => entry.artifact),
    ...manifest.releaseGates.flatMap((entry) => [entry.definition, entry.report]),
    manifest.releaseNotes,
  ].sort((left, right) => left.name.localeCompare(right.name));
}

function compareProjection(existing, generated, label) {
  if (existing !== undefined && canonicalJson(existing) !== canonicalJson(generated)) fail(`${label} projection drift`);
  return generated;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function serializeMetadata(metadata) {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

export function signMetadata(signed, keyId, privateKey) {
  expectString(keyId, "signing key ID", keyIdPattern);
  const signature = sign(null, signaturePayload(signed), privateKey).toString("base64");
  return { signed, signatures: [{ keyId, algorithm: "ed25519", signature }] };
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyTrustMetadata(envelope, { trustedRootKeys, now = new Date(), accepted } = {}) {
  validateTrust(envelope);
  if (!(trustedRootKeys instanceof Map) || trustedRootKeys.size === 0) fail("No trusted root keys configured");
  verifyAtLeastOneSignature(envelope, trustedRootKeys, "Trust metadata is not signed by a trusted root key");
  if (Date.parse(envelope.signed.expires) <= now.getTime()) fail("Trust metadata expired");
  const acceptedState = {
    version: envelope.signed.version,
    envelopeSha256: envelopeDigest(envelope),
  };
  if (accepted) {
    expectObject(accepted, "accepted trust state", ["version", "envelopeSha256"]);
    expectInteger(accepted.version, "accepted trust version", 0);
    expectString(accepted.envelopeSha256, "accepted trust envelope digest", sha256Pattern);
    if (acceptedState.version < accepted.version) fail("Release trust metadata version replay");
    if (acceptedState.version === accepted.version && acceptedState.envelopeSha256 !== accepted.envelopeSha256) {
      fail("Equal trust metadata version is not an identical retry");
    }
  }
  return {
    metadata: envelope.signed,
    releaseKeys: new Map(envelope.signed.releaseKeys.map((entry) => [entry.keyId, entry])),
    acceptedState,
  };
}

export function verifyReleaseManifest(envelope, { trust, now = new Date() }) {
  validateReleaseManifestEnvelope(envelope);
  verifyDelegated(envelope, trust, now);
  return envelope.signed;
}

export function verifyChannel(envelope, { trust, now = new Date(), manifest, accepted }) {
  validateChannel(envelope);
  verifyDelegated(envelope, trust, now);
  if (Date.parse(envelope.signed.expires) <= now.getTime()) fail("Release Channel expired");
  verifyReleaseManifest(manifest, { trust, now });
  const actualManifestDigest = createHash("sha256").update(serializeMetadata(manifest)).digest("hex");
  if (actualManifestDigest !== envelope.signed.manifest.sha256) fail("Release Channel manifest digest mismatch");
  if (manifest.signed.releaseId !== envelope.signed.manifest.releaseId) fail("Release Channel manifest identity mismatch");
  const acceptedState = {
    sequence: envelope.signed.sequence,
    releaseId: envelope.signed.manifest.releaseId,
    manifestSha256: envelope.signed.manifest.sha256,
    envelopeSha256: envelopeDigest(envelope),
  };
  if (accepted) {
    expectObject(accepted, "accepted Channel state", ["sequence", "releaseId", "manifestSha256", "envelopeSha256"]);
    expectInteger(accepted.sequence, "accepted channel sequence", 0);
    expectString(accepted.releaseId, "accepted manifest release ID", releaseIdPattern);
    expectString(accepted.manifestSha256, "accepted manifest digest", sha256Pattern);
    expectString(accepted.envelopeSha256, "accepted Channel envelope digest", sha256Pattern);
    if (acceptedState.sequence < accepted.sequence) fail("Release Channel sequence replay");
    if (acceptedState.sequence === accepted.sequence && acceptedState.envelopeSha256 !== accepted.envelopeSha256) {
      fail("Equal Channel sequence is not an identical retry");
    }
  }
  return acceptedState;
}

export function createArtifactManifest(manifest, { existing } = {}) {
  return compareProjection(existing, {
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    assets: releaseArtifacts(manifest),
  }, "artifact-manifest.json");
}

export function createChecksums(manifest, { existing } = {}) {
  const generated = `${releaseArtifacts(manifest).map((artifact) => `${artifact.sha256}  ${artifact.name}`).join("\n")}\n`;
  if (existing !== undefined && existing !== generated) fail("SHA256SUMS projection drift");
  return generated;
}

export function createArchiveMetadata(manifest, platform, { existing } = {}) {
  const archive = manifest.platformArchives.find((entry) => entry.platform === platform);
  if (!archive) fail(`Platform is not declared by Release Manifest: ${platform}`);
  return compareProjection(existing, {
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    upstream: manifest.upstream,
    platform,
    questionTool: {
      name: manifest.compatibility.questionTool.name,
      version: manifest.compatibility.questionTool.version,
    },
  }, `archive ${platform} release.json`);
}

export function createReceipt(manifest, platform, ownedPath, { existing } = {}) {
  expectString(ownedPath, "receipt owned path");
  const archive = manifest.platformArchives.find((entry) => entry.platform === platform);
  if (!archive) fail(`Platform is not declared by Release Manifest: ${platform}`);
  return compareProjection(existing, {
    schemaVersion: 1,
    ownedPath,
    releaseId: manifest.releaseId,
    managerReleaseId: manifest.manager.releaseId,
    platform,
    payload: archive.payload,
  }, "receipt");
}

export function verifyReleaseIdentityProjections(manifest, root) {
  const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const candidateVersion = manifest.releaseId.startsWith("pi-v") ? manifest.releaseId.slice(4) : "";
  if (packageManifest.version !== candidateVersion) fail("Package release candidate projection drift");
  if (packageManifest.piWaitForUser?.managerReleaseId !== manifest.manager.releaseId
    || canonicalJson(packageManifest.piWaitForUser?.compatibleReleaseManifestVersions)
      !== canonicalJson(manifest.manager.compatibleReleaseManifestVersions)) {
    fail("Manager Release package projection drift");
  }

  const shellIdentity = (path, variable, expected, label) => {
    const contents = readFileSync(join(root, path), "utf8");
    const matches = [...contents.matchAll(new RegExp(`^${variable}="([^"]*)"$`, "gm"))];
    if (matches.length !== 1 || matches[0][1] !== expected) fail(`${label} projection drift`);
  };
  shellIdentity("scripts/bootstrap.sh", "release_id", manifest.releaseId, "Bootstrap release ID");
  shellIdentity("scripts/install-binary.sh", "release_id", manifest.releaseId, "Binary installer release ID");
  shellIdentity("scripts/install-binary.sh", "pi_version", manifest.upstream.packageVersion, "Binary installer Pi version");

  const verifyFile = (artifact, path, label) => {
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.size !== artifact.size || sha256File(absolute) !== artifact.sha256) {
      fail(`${label} projection drift`);
    }
  };
  verifyFile(manifest.bootstrap.installer, "scripts/bootstrap.sh", "Bootstrap installer");
  verifyFile(manifest.compatibility.questionTool.manifest, manifest.compatibility.questionTool.manifest.name, "Question Tool manifest");
  verifyFile(manifest.releaseNotes, join("releases", manifest.releaseId, "RELEASE_NOTES.md"), "Release documentation");

  const readme = readFileSync(join(root, "README.md"), "utf8");
  if (!readme.includes(`The packaged release candidate is **\`${manifest.releaseId}\`**`)) {
    fail("README release candidate projection drift");
  }
  if (!readme.includes(`/download/${manifest.releaseId}/install.sh`)) fail("README installer projection drift");
  const notes = readFileSync(join(root, "releases", manifest.releaseId, "RELEASE_NOTES.md"), "utf8");
  if (!notes.includes(`# Pi Wait for User · \`${manifest.releaseId}\``)) fail("Release notes identity projection drift");
  if (!notes.includes(`/download/${manifest.releaseId}/install.sh`)) fail("Release notes installer projection drift");
}

export function createCompatibilityActiveRelease(channel, manifest, { existing } = {}) {
  if (channel.manifest.releaseId !== manifest.signed.releaseId) fail("Release Channel manifest identity mismatch");
  return compareProjection(existing, {
    schemaVersion: 1,
    generatedFrom: "release-channel",
    channelSequence: channel.sequence,
    releaseId: channel.manifest.releaseId,
    manifestSha256: channel.manifest.sha256,
  }, "active.json");
}

export function createPayloadInventory(root) {
  const files = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const path = relative(root, absolute).split(sep).join("/");
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`Payload contains symbolic link: ${path}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        files.push({
          path,
          sha256: sha256File(absolute),
          size: stat.size,
          mode: stat.mode & 0o777,
        });
      } else fail(`Payload contains unsupported file: ${path}`);
    }
  }
  visit(root);
  return files;
}

export function verifyReleasePayloads(root, payload) {
  const declared = [...payload].sort((left, right) => left.path.localeCompare(right.path));
  const actual = createPayloadInventory(root).sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalJson(actual.map((entry) => entry.path)) !== canonicalJson(declared.map((entry) => entry.path))) {
    fail("Extracted payload inventory mismatch");
  }
  for (let index = 0; index < declared.length; index += 1) {
    const expected = declared[index];
    const found = actual[index];
    if (found.size !== expected.size) fail(`Payload size mismatch: ${expected.path}`);
    if (found.sha256 !== expected.sha256) fail(`Payload digest mismatch: ${expected.path}`);
    if (found.mode !== expected.mode) fail(`Payload mode mismatch: ${expected.path}`);
  }
}

export function verifyProvenance(manifest, verified) {
  for (const field of ["repository", "workflow", "sourceCommit"]) {
    if (verified[field] !== manifest.provenance[field]) fail(`Provenance ${field} mismatch`);
  }
  if (canonicalJson(verified.artifacts) !== canonicalJson(manifest.provenance.artifacts)) {
    fail("Provenance artifact mismatch");
  }
}
