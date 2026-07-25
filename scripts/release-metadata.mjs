#!/usr/bin/env node

import { createHash, createPublicKey } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  createArchiveMetadata,
  createArtifactManifest,
  createChecksums,
  createCompatibilityActiveRelease,
  createReceipt,
  publicKeyFingerprint,
  serializeMetadata,
  signMetadata,
  verifyChannel,
  verifyProvenance,
  verifyReleaseIdentityProjections,
  verifyReleaseManifest,
  verifyTrustMetadata,
} from "./lib/release-metadata.mjs";

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeMetadata(value), { flag: "wx" });
}

function parseOptions(args) {
  const options = new Map();
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (!flag?.startsWith("--") || value === undefined || options.has(flag)) fail(usage());
    options.set(flag, value);
  }
  return options;
}

function clearReceiptPreflightEvidence(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--preflight-report" && args[index + 1] !== undefined) {
      rmSync(resolve(args[index + 1]), { force: true });
    }
  }
}

function required(options, flag) {
  const value = options.get(flag);
  if (!value) fail(`Missing required option: ${flag}`);
  return value;
}

function allowed(options, flags) {
  for (const flag of options.keys()) if (!flags.includes(flag)) fail(`Unknown option: ${flag}`);
}

function rootKey(options) {
  const root = required(options, "--root-key");
  const separator = root.indexOf("=");
  if (separator < 1 || separator === root.length - 1) fail("--root-key must be KEY_ID=PUBLIC_KEY_PATH");
  return {
    keyId: root.slice(0, separator),
    publicKey: readFileSync(resolve(root.slice(separator + 1)), "utf8"),
  };
}

function verificationTime(options) {
  const now = options.has("--now") ? new Date(options.get("--now")) : new Date();
  if (!Number.isFinite(now.getTime())) fail("--now must be an ISO date-time");
  return now;
}

function authority(options) {
  const trustPath = resolve(required(options, "--trust"));
  const trustEnvelope = readJson(trustPath);
  const root = rootKey(options);
  const now = verificationTime(options);
  return {
    trust: verifyTrustMetadata(trustEnvelope, {
      trustedRootKeys: new Map([[root.keyId, root.publicKey]]),
      now,
      accepted: options.has("--accepted-trust-state")
        ? readJson(resolve(options.get("--accepted-trust-state")))
        : undefined,
    }),
    root,
    now,
  };
}

function exactObject(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`Malformed ${label}`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`Malformed ${label}`);
  return value;
}

function readPublicKey(path) {
  const value = readFileSync(path, "utf8");
  if (!value.includes("-----BEGIN PUBLIC KEY-----") || value.includes("PRIVATE KEY")) {
    fail(`Expected an SPKI public key: ${path}`);
  }
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") fail(`Public key must be Ed25519: ${path}`);
    return key.export({ type: "spki", format: "pem" }).toString();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Public key must be Ed25519")) throw error;
    fail(`Malformed public key: ${path}`);
  }
}

function signTrust(options) {
  allowed(options, ["--input", "--root-key-id", "--root-private-key", "--root-public-key", "--now", "--output"]);
  const inputPath = resolve(required(options, "--input"));
  const input = exactObject(readJson(inputPath), [
    "schemaVersion", "type", "version", "expires", "channelUrl", "releaseKeys",
  ], "release trust signing input");
  if (!Array.isArray(input.releaseKeys) || input.releaseKeys.length === 0) fail("Malformed release trust signing input");
  const releaseKeys = input.releaseKeys.map((entry, index) => {
    exactObject(entry, ["keyId", "algorithm", "publicKeyFile", "expires", "revoked"], `releaseKeys[${index}]`);
    if (typeof entry.publicKeyFile !== "string" || entry.publicKeyFile.length === 0) fail(`Malformed releaseKeys[${index}]`);
    return {
      keyId: entry.keyId,
      algorithm: entry.algorithm,
      publicKey: readPublicKey(resolve(dirname(inputPath), entry.publicKeyFile)),
      expires: entry.expires,
      revoked: entry.revoked,
    };
  });
  const rootPublicKey = readPublicKey(resolve(required(options, "--root-public-key")));
  const rootKeyId = required(options, "--root-key-id");
  const envelope = signMetadata({
    schemaVersion: input.schemaVersion,
    type: input.type,
    version: input.version,
    expires: input.expires,
    channelUrl: input.channelUrl,
    releaseKeys,
  }, rootKeyId, readFileSync(resolve(required(options, "--root-private-key")), "utf8"));
  const verified = verifyTrustMetadata(envelope, {
    trustedRootKeys: new Map([[rootKeyId, rootPublicKey]]),
    now: verificationTime(options),
  });
  const output = resolve(required(options, "--output"));
  writeJson(output, envelope);
  console.log(`Created and verified release trust metadata version ${verified.metadata.version}: ${output}`);
  console.log(`Root public key SHA-256 fingerprint (SPKI DER): ${publicKeyFingerprint(rootPublicKey)}`);
}

function verifyTrust(options) {
  allowed(options, ["--trust", "--root-key", "--accepted-trust-state", "--now"]);
  const root = rootKey(options);
  const { trust } = authority(options);
  console.log(`Verified release trust metadata version ${trust.metadata.version}.`);
  console.log(`Root public key SHA-256 fingerprint (SPKI DER): ${publicKeyFingerprint(root.publicKey)}`);
}

function fingerprint(options) {
  allowed(options, ["--public-key"]);
  console.log(publicKeyFingerprint(readPublicKey(resolve(required(options, "--public-key")))));
}

function signManifest(options) {
  allowed(options, ["--input", "--provenance", "--trust", "--root-key", "--accepted-trust-state", "--now", "--key-id", "--private-key", "--release-root", "--output"]);
  const unsigned = readJson(resolve(required(options, "--input")));
  const provenance = readJson(resolve(required(options, "--provenance")));
  verifyProvenance(unsigned, provenance);
  const envelope = signMetadata(
    unsigned,
    required(options, "--key-id"),
    readFileSync(resolve(required(options, "--private-key")), "utf8"),
  );
  const { trust, now } = authority(options);
  const verifiedManifest = verifyReleaseManifest(envelope, { trust, now });
  if (options.has("--release-root")) verifyReleaseIdentityProjections(verifiedManifest, resolve(options.get("--release-root")));
  const output = resolve(required(options, "--output"));
  writeJson(output, envelope);
  console.log(`Signed and verified Release Manifest ${unsigned.releaseId}: ${output}`);
}

function promote(options) {
  allowed(options, [
    "--manifest", "--trust", "--root-key", "--now", "--key-id", "--private-key", "--sequence", "--expires",
    "--manifest-url", "--output", "--accepted-state", "--accepted-trust-state", "--bootstrap",
  ]);
  const manifest = readJson(resolve(required(options, "--manifest")));
  const { trust, now } = authority(options);
  const signedManifest = verifyReleaseManifest(manifest, { trust, now });
  const sequence = Number(required(options, "--sequence"));
  if (!Number.isSafeInteger(sequence) || sequence < 1) fail("--sequence must be a positive integer");
  const channel = signMetadata({
    schemaVersion: 1,
    type: "release-channel",
    sequence,
    expires: required(options, "--expires"),
    manifest: {
      releaseId: signedManifest.releaseId,
      url: required(options, "--manifest-url"),
      sha256: createHash("sha256").update(serializeMetadata(manifest)).digest("hex"),
    },
  }, required(options, "--key-id"), readFileSync(resolve(required(options, "--private-key")), "utf8"));
  let accepted;
  if (options.has("--accepted-state")) {
    accepted = readJson(resolve(options.get("--accepted-state")));
  } else if (options.get("--bootstrap") === "true" && sequence === 1) {
    accepted = undefined;
  } else {
    fail("Promotion requires --accepted-state, or --bootstrap true for Channel sequence 1");
  }
  const selection = verifyChannel(channel, { trust, now, manifest, accepted });

  const output = resolve(required(options, "--output"));
  mkdirSync(output, { recursive: true });
  writeJson(join(output, "trust-state.json"), trust.acceptedState);
  writeJson(join(output, "channel.json"), channel);
  writeJson(join(output, "channel-state.json"), selection);
  writeJson(join(output, "active.json"), createCompatibilityActiveRelease(channel.signed, manifest));
  writeJson(join(output, "artifact-manifest.json"), createArtifactManifest(signedManifest));
  writeFileSync(join(output, "SHA256SUMS"), createChecksums(signedManifest), { flag: "wx" });
  for (const archive of signedManifest.platformArchives) {
    writeJson(join(output, `archive-metadata-${archive.platform}.json`), createArchiveMetadata(signedManifest, archive.platform));
  }
  console.log(`Promoted ${signedManifest.releaseId} at Channel sequence ${sequence}: ${output}`);
}

function createVerifiedReceipt(options) {
  allowed(options, [
    "--manifest", "--trust", "--root-key", "--accepted-trust-state", "--now", "--platform", "--owned-path", "--output",
  ]);
  const { signedManifest } = loadVerifiedReceiptManifest(options);
  const receipt = createReceipt(
    signedManifest,
    required(options, "--platform"),
    required(options, "--owned-path"),
  );
  const output = resolve(required(options, "--output"));
  writeJson(output, receipt);
  console.log(`Generated verified receipt for ${signedManifest.releaseId}: ${output}`);
}

const managedReceiptPlatforms = ["darwin-arm64", "linux-arm64", "linux-x64"];
const receiptName = (platform) => `installation-receipt-${platform}.json`;
const expectedReceiptOutputs = managedReceiptPlatforms.map(receiptName);

// Cryptographic identity of test/fixtures/release-keys, whose private counterparts are public test fixtures.
const checkedInPublicFixtureAuthority = {
  rootKeyId: "fixture-root-2026",
  rootSpkiSha256: "463b162316bb6e680f37b9203566df7b5efdaaf44c3906b807173314be800f5e",
  trustEnvelopeSha256: "0344a2669e5a6ad787f1b7c196f109aee4ceb0008fe20c2a6a4c96e7ddb7c52d",
  releaseKeys: [{
    keyId: "fixture-release-2026",
    spkiSha256: "4599deb1ddc5c67edffebaff0a1953f02d5f572bf9892b34b08c01a6ba727d96",
  }],
};

function readReceiptManifest(path) {
  let contents;
  try {
    contents = readFileSync(resolve(path), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") fail("Missing Release Manifest");
    throw error;
  }
  try {
    return JSON.parse(contents);
  } catch {
    fail("Malformed Release Manifest JSON");
  }
}

function loadVerifiedReceiptManifest(options) {
  const manifest = readReceiptManifest(required(options, "--manifest"));
  const verifiedAuthority = authority(options);
  return {
    manifest,
    signedManifest: verifyReleaseManifest(manifest, verifiedAuthority),
    ...verifiedAuthority,
  };
}

function receiptOutputInventory(output) {
  return readdirSync(output).filter((name) => name.startsWith("installation-receipt-")).sort();
}

function projectVerifiedReceipts(options) {
  const projected = loadVerifiedReceiptManifest(options);
  const { manifest, signedManifest } = projected;
  const declaredManagedPlatforms = signedManifest.platformArchives
    .map(({ platform }) => platform)
    .filter((platform) => platform.startsWith("darwin-") || platform.startsWith("linux-"))
    .sort();
  if (JSON.stringify(declaredManagedPlatforms) !== JSON.stringify(managedReceiptPlatforms)) {
    fail(`Managed receipt platform inventory must be exactly: ${managedReceiptPlatforms.join(", ")}`);
  }

  const output = resolve(required(options, "--output"));
  mkdirSync(output, { recursive: true });
  const existingOutputs = receiptOutputInventory(output);
  if (existingOutputs.length > 0) fail("Receipt output inventory must be empty before projection");
  for (const platform of managedReceiptPlatforms) {
    writeJson(join(output, receiptName(platform)), createReceipt(
      signedManifest,
      platform,
      required(options, "--owned-path"),
    ));
  }
  const actualOutputs = receiptOutputInventory(output);
  if (JSON.stringify(actualOutputs) !== JSON.stringify(expectedReceiptOutputs)) fail("Receipt output inventory mismatch");
  return projected;
}

function publicFixtureAuthorityIdentity(projected) {
  const releaseKeyIds = projected.manifest.signatures.map(({ keyId }) => keyId).sort();
  return {
    rootKeyId: projected.root.keyId,
    rootSpkiSha256: publicKeyFingerprint(projected.root.publicKey),
    trustEnvelopeSha256: projected.trust.acceptedState.envelopeSha256,
    releaseKeys: releaseKeyIds.map((keyId) => ({
      keyId,
      spkiSha256: publicKeyFingerprint(projected.trust.releaseKeys.get(keyId).publicKey),
    })),
  };
}

function expectFailedClosed(callback, expected) {
  try {
    callback();
  } catch (error) {
    if (error instanceof Error && expected.test(error.message)) return;
    throw error;
  }
  fail("Receipt preflight probe did not fail closed");
}

function createVerifiedReceipts(options) {
  const reportPath = options.has("--preflight-report")
    ? resolve(required(options, "--preflight-report"))
    : undefined;
  if (reportPath) rmSync(reportPath, { force: true });
  allowed(options, [
    "--manifest", "--trust", "--root-key", "--accepted-trust-state", "--now", "--owned-path", "--output",
    "--preflight-report", "--summary",
  ]);
  if (options.has("--summary") !== options.has("--preflight-report")) {
    fail("--preflight-report and --summary are required together");
  }
  const manifestArgument = required(options, "--manifest");
  const projected = projectVerifiedReceipts(options);
  if (reportPath) {
    if (isAbsolute(manifestArgument)) fail("Receipt preflight requires a workspace-relative Release Manifest path");
    const fixtureAuthority = publicFixtureAuthorityIdentity(projected);
    if (serializeMetadata(fixtureAuthority) !== serializeMetadata(checkedInPublicFixtureAuthority)) {
      fail("Receipt preflight requires the explicitly identified public fixture authority");
    }
    mkdirSync(dirname(reportPath), { recursive: true });
    const temporary = mkdtempSync(join(dirname(reportPath), ".receipt-preflight-"));
    try {
      const probe = (manifestPath, output) => {
        const probeOptions = new Map(options);
        probeOptions.delete("--preflight-report");
        probeOptions.delete("--summary");
        probeOptions.set("--manifest", manifestPath);
        probeOptions.set("--output", output);
        return projectVerifiedReceipts(probeOptions);
      };
      probe(resolve(manifestArgument), join(temporary, "absolute-output"));
      expectFailedClosed(
        () => probe(join(temporary, "missing-release-manifest.json"), join(temporary, "missing-output")),
        /^Missing Release Manifest$/,
      );
      const malformedPath = join(temporary, "malformed-release-manifest.json");
      writeFileSync(malformedPath, "{}\n", { flag: "wx" });
      expectFailedClosed(
        () => probe(malformedPath, join(temporary, "malformed-output")),
        /^Malformed release-manifest metadata/,
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    if (options.has("--summary")) {
      const summaryPath = resolve(required(options, "--summary"));
      mkdirSync(dirname(summaryPath), { recursive: true });
      writeFileSync(summaryPath, [
        "## Production receipt preflight: passed",
        "",
        `- Generated exact managed receipt inventory: ${managedReceiptPlatforms.join(", ")}.`,
        "- Loaded the generated Release Manifest through workspace-relative and absolute paths.",
        "- The missing and malformed Release Manifest probes failed closed.",
        "- Authority: public fixture root and delegated release key material only.",
        "",
      ].join("\n"), { flag: "a" });
    }
    writeJson(reportPath, {
      schemaVersion: 1,
      type: "production-receipt-preflight",
      result: "passed",
      releaseId: projected.signedManifest.releaseId,
      authority: fixtureAuthority,
      expectedPlatforms: managedReceiptPlatforms,
      expectedOutputs: expectedReceiptOutputs,
      manifestLoading: { workspaceRelative: "passed", absolute: "passed" },
      failClosedProbes: { missingManifest: "passed", malformedManifest: "passed" },
    });
  }
  console.log(`Generated verified receipts for ${projected.signedManifest.releaseId}: ${managedReceiptPlatforms.join(", ")}`);
}

function verifyMetadata(options) {
  allowed(options, [
    "--manifest", "--channel", "--trust", "--root-key", "--accepted-trust-state", "--now", "--accepted-state", "--active",
    "--artifact-manifest", "--checksums", "--archive-metadata-dir", "--release-root",
  ]);
  const manifest = readJson(resolve(required(options, "--manifest")));
  const channel = readJson(resolve(required(options, "--channel")));
  const { trust, now } = authority(options);
  const accepted = options.has("--accepted-state") ? readJson(resolve(options.get("--accepted-state"))) : undefined;
  const selection = verifyChannel(channel, { trust, now, manifest, accepted });
  const signedManifest = manifest.signed;
  if (options.has("--release-root")) verifyReleaseIdentityProjections(signedManifest, resolve(options.get("--release-root")));
  if (options.has("--active")) {
    createCompatibilityActiveRelease(channel.signed, manifest, { existing: readJson(resolve(options.get("--active"))) });
  }
  if (options.has("--artifact-manifest")) {
    createArtifactManifest(signedManifest, { existing: readJson(resolve(options.get("--artifact-manifest"))) });
  }
  if (options.has("--checksums")) {
    createChecksums(signedManifest, { existing: readFileSync(resolve(options.get("--checksums")), "utf8") });
  }
  if (options.has("--archive-metadata-dir")) {
    const directory = resolve(options.get("--archive-metadata-dir"));
    for (const archive of signedManifest.platformArchives) {
      createArchiveMetadata(signedManifest, archive.platform, {
        existing: readJson(join(directory, `archive-metadata-${archive.platform}.json`)),
      });
    }
  }
  console.log(`Verified ${selection.releaseId} at Channel sequence ${selection.sequence}.`);
}

function usage() {
  return [
    "Usage:",
    "  release-metadata.mjs sign-trust --input FILE --root-key-id ID --root-private-key FILE --root-public-key FILE --output FILE [--now DATE]",
    "  release-metadata.mjs verify-trust --trust FILE --root-key ID=FILE [--accepted-trust-state FILE] [--now DATE]",
    "  release-metadata.mjs fingerprint --public-key FILE",
    "  release-metadata.mjs sign-manifest --input FILE --provenance FILE --trust FILE --root-key ID=FILE --key-id ID --private-key FILE --output FILE [--release-root DIR] [--accepted-trust-state FILE] [--now DATE]",
    "  release-metadata.mjs promote --manifest FILE --trust FILE --root-key ID=FILE --key-id ID --private-key FILE --sequence N --expires DATE --manifest-url URL --output DIR (--accepted-state FILE | --bootstrap true) [--accepted-trust-state FILE] [--now DATE]",
    "  release-metadata.mjs receipt --manifest FILE --trust FILE --root-key ID=FILE --platform PLATFORM --owned-path PATH --output FILE [--accepted-trust-state FILE] [--now DATE]",
    "  release-metadata.mjs receipts --manifest FILE --trust FILE --root-key ID=FILE --owned-path PATH --output DIR [--preflight-report FILE --summary FILE] [--accepted-trust-state FILE] [--now DATE]",
    "  release-metadata.mjs verify --manifest FILE --channel FILE --trust FILE --root-key ID=FILE [--accepted-trust-state FILE] [--accepted-state FILE] [--active FILE --artifact-manifest FILE --checksums FILE --archive-metadata-dir DIR --release-root DIR] [--now DATE]",
  ].join("\n");
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "receipts") clearReceiptPreflightEvidence(args);
  const options = parseOptions(args);
  if (command === "sign-trust") signTrust(options);
  else if (command === "verify-trust") verifyTrust(options);
  else if (command === "fingerprint") fingerprint(options);
  else if (command === "sign-manifest") signManifest(options);
  else if (command === "promote") promote(options);
  else if (command === "receipt") createVerifiedReceipt(options);
  else if (command === "receipts") createVerifiedReceipts(options);
  else if (command === "verify") verifyMetadata(options);
  else fail(usage());
} catch (error) {
  console.error(`${basename(process.argv[1])}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
