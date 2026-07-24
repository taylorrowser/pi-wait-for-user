#!/usr/bin/env node

import { createHash, createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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
  const root = rootKey(options);
  const now = verificationTime(options);
  return {
    trust: verifyTrustMetadata(readJson(trustPath), {
      trustedRootKeys: new Map([[root.keyId, root.publicKey]]),
      now,
      accepted: options.has("--accepted-trust-state")
        ? readJson(resolve(options.get("--accepted-trust-state")))
        : undefined,
    }),
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
    return createPublicKey(value).export({ type: "spki", format: "pem" }).toString();
  } catch {
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
  const manifest = readJson(resolve(required(options, "--manifest")));
  const { trust, now } = authority(options);
  const signedManifest = verifyReleaseManifest(manifest, { trust, now });
  const receipt = createReceipt(
    signedManifest,
    required(options, "--platform"),
    required(options, "--owned-path"),
  );
  const output = resolve(required(options, "--output"));
  writeJson(output, receipt);
  console.log(`Generated verified receipt for ${signedManifest.releaseId}: ${output}`);
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
    "  release-metadata.mjs verify --manifest FILE --channel FILE --trust FILE --root-key ID=FILE [--accepted-trust-state FILE] [--accepted-state FILE] [--active FILE --artifact-manifest FILE --checksums FILE --archive-metadata-dir DIR --release-root DIR] [--now DATE]",
  ].join("\n");
}

try {
  const [command, ...args] = process.argv.slice(2);
  const options = parseOptions(args);
  if (command === "sign-trust") signTrust(options);
  else if (command === "verify-trust") verifyTrust(options);
  else if (command === "fingerprint") fingerprint(options);
  else if (command === "sign-manifest") signManifest(options);
  else if (command === "promote") promote(options);
  else if (command === "receipt") createVerifiedReceipt(options);
  else if (command === "verify") verifyMetadata(options);
  else fail(usage());
} catch (error) {
  console.error(`${basename(process.argv[1])}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
