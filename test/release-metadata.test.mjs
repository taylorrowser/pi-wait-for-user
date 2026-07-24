import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createArtifactManifest,
  createArchiveMetadata,
  createChecksums,
  createCompatibilityActiveRelease,
  createPayloadInventory,
  createReceipt,
  serializeMetadata,
  signMetadata,
  verifyChannel,
  verifyProvenance,
  verifyReleaseManifest,
  verifyReleasePayloads,
  verifyTrustMetadata,
} from "../scripts/lib/release-metadata.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const keys = join(root, "test", "fixtures", "release-keys");
const metadataCli = join(root, "scripts", "release-metadata.mjs");
const rootPrivate = readFileSync(join(keys, "root-private.pem"), "utf8");
const rootPublic = readFileSync(join(keys, "root-public.pem"), "utf8");
const releasePrivate = readFileSync(join(keys, "release-private.pem"), "utf8");
const releasePublic = readFileSync(join(keys, "release-public.pem"), "utf8");
const unauthorizedPrivate = readFileSync(join(keys, "unauthorized-private.pem"), "utf8");
const now = new Date("2026-07-24T12:00:00.000Z");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(name, contents) {
  return { name, sha256: digest(contents), size: Buffer.byteLength(contents) };
}

function trust(overrides = {}) {
  return signMetadata({
    schemaVersion: 1,
    type: "release-trust",
    version: 3,
    expires: "2027-01-01T00:00:00.000Z",
    channelUrl: "https://raw.githubusercontent.com/taylorrowser/pi-wait-for-user/main/releases/channel.json",
    releaseKeys: [{
      keyId: "fixture-release-2026",
      algorithm: "ed25519",
      publicKey: releasePublic,
      expires: "2026-12-01T00:00:00.000Z",
      revoked: false,
    }],
    ...overrides,
  }, "fixture-root-2026", rootPrivate);
}

function manifest(overrides = {}) {
  const archive = artifact("pi-wait-for-user-linux-x64.tar.gz", "archive");
  const manager = artifact("pi-wait-for-user-pi-v0.81.1-patch.6.tgz", "manager");
  const questionPackage = artifact("taylorrowser-pi-question-tool-0.1.3.tgz", "question package");
  const installer = artifact("install.sh", "installer");
  const gateDefinition = artifact("fixture-gate.json", "gate definition");
  const report = artifact("release-candidate.json", "report");
  const notes = artifact("RELEASE_NOTES.md", "notes");
  return signMetadata({
    schemaVersion: 1,
    type: "release-manifest",
    releaseId: "pi-v0.81.1-patch.6",
    tag: "pi-v0.81.1-patch.6",
    publishedAt: "2026-07-24T10:00:00.000Z",
    upstream: {
      repository: "https://github.com/earendil-works/pi.git",
      tag: "v0.81.1",
      commit: "20be4b18d4c57487f8993d2762bace129f0cf7c6",
      packageVersion: "0.81.1",
    },
    patches: [
      { order: 1, path: "patches/active/0001.patch", sha256: digest("patch one"), size: 9 },
      { order: 2, path: "patches/active/0002.patch", sha256: digest("patch two"), size: 9 },
    ],
    compatibility: {
      questionTool: {
        name: "@taylorrowser/pi-question-tool",
        version: "0.1.3",
        manifest: artifact("packages/question-tool/package.json", "question manifest"),
        package: questionPackage,
        coreProtocolVersions: [1],
        handlerId: "dev.taylorrowser.pi-question-tool.question",
        handlerVersion: 1,
        packageSchemaVersions: [1],
      },
      sessions: {
        identities: [{ id: "dev.taylorrowser.pi-wait-for-user/session", version: 1 }],
        readableCoreProtocolVersions: [1],
        readableHandlers: [{ id: "dev.taylorrowser.pi-question-tool.question", versions: [1] }],
      },
    },
    manager: {
      releaseId: "manager-v1",
      compatibleReleaseManifestVersions: [1],
      artifacts: [manager],
    },
    bootstrap: { installer },
    platformArchives: [{
      platform: "linux-x64",
      artifact: archive,
      payload: [
        { path: "pi-wait-for-user/pi-core", sha256: digest("binary"), size: 6, mode: 493 },
        { path: "pi-wait-for-user/release.json", sha256: digest("metadata"), size: 8, mode: 420 },
      ],
    }],
    releaseGates: [{ name: "release-candidate", status: "passed", definition: gateDefinition, report }],
    provenance: {
      repository: "taylorrowser/pi-wait-for-user",
      workflow: ".github/workflows/release.yml",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      artifacts: [manager, questionPackage, installer, gateDefinition, archive, report, notes]
        .map(({ name, sha256 }) => ({ name, sha256 }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    },
    releaseNotes: notes,
    ...overrides,
  }, "fixture-release-2026", releasePrivate);
}

function channel(releaseManifest, overrides = {}) {
  const encoded = serializeMetadata(releaseManifest);
  return signMetadata({
    schemaVersion: 1,
    type: "release-channel",
    sequence: 11,
    expires: "2026-08-01T00:00:00.000Z",
    manifest: {
      releaseId: releaseManifest.signed.releaseId,
      url: `https://github.com/taylorrowser/pi-wait-for-user/releases/download/${releaseManifest.signed.releaseId}/release-manifest.json`,
      sha256: digest(encoded),
    },
    ...overrides,
  }, "fixture-release-2026", releasePrivate);
}

function verifiedTrust(value = trust(), at = now) {
  return verifyTrustMetadata(value, {
    trustedRootKeys: new Map([["fixture-root-2026", rootPublic]]),
    now: at,
  });
}

test("authorized root and release signatures verify complete metadata", () => {
  const authority = verifiedTrust();
  const releaseManifest = manifest();
  const verifiedManifest = verifyReleaseManifest(releaseManifest, { trust: authority, now });
  const previous = channel(releaseManifest, { sequence: 10 });
  const selected = verifyChannel(channel(releaseManifest), {
    trust: authority,
    now,
    manifest: releaseManifest,
    accepted: verifyChannel(previous, { trust: authority, now, manifest: releaseManifest }),
  });

  assert.equal(verifiedManifest.releaseId, "pi-v0.81.1-patch.6");
  assert.equal(selected.sequence, 11);
  assert.equal(selected.manifestSha256, channel(releaseManifest).signed.manifest.sha256);
  assert.equal(selected.releaseId, "pi-v0.81.1-patch.6");
  assert.match(selected.envelopeSha256, /^[a-f0-9]{64}$/);
});

test("unknown schemas, expired trust, malformed metadata, unauthorized signatures, and non-Ed25519 keys fail closed", () => {
  assert.throws(() => verifiedTrust(trust({ schemaVersion: 99 })), /unknown release-trust schema version 99/i);
  assert.throws(() => verifiedTrust(trust({ expires: "2026-01-01T00:00:00.000Z" })), /trust metadata expired/i);
  assert.throws(() => verifiedTrust({ signed: {}, signatures: [] }), /malformed release-trust metadata/i);

  const authority = verifiedTrust();
  assert.throws(
    () => verifyReleaseManifest(manifest({ schemaVersion: 99 }), { trust: authority, now }),
    /unknown release-manifest schema version 99/i,
  );
  const validManifest = manifest();
  assert.throws(
    () => verifyChannel(channel(validManifest, { schemaVersion: 99 }), { trust: authority, now, manifest: validManifest }),
    /unknown release-channel schema version 99/i,
  );
  const unauthorized = signMetadata(validManifest.signed, "not-delegated", unauthorizedPrivate);
  assert.throws(
    () => verifyReleaseManifest(unauthorized, { trust: authority, now }),
    /not authorized by release trust/i,
  );
  const invalid = structuredClone(validManifest);
  invalid.signatures[0].signature = `${invalid.signatures[0].signature.slice(0, -4)}AAAA`;
  assert.throws(() => verifyReleaseManifest(invalid, { trust: authority, now }), /invalid release-manifest signature/i);

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => signMetadata(
    validManifest.signed,
    "not-ed25519",
    rsa.privateKey.export({ type: "pkcs8", format: "pem" }),
  ), /must be Ed25519/i);
  const mislabeledRsaEnvelope = {
    signed: validManifest.signed,
    signatures: [{
      keyId: "rsa-release",
      algorithm: "ed25519",
      signature: "AAAA",
    }],
  };
  assert.throws(() => verifyReleaseManifest(mislabeledRsaEnvelope, {
    trust: {
      releaseKeys: new Map([["rsa-release", {
        keyId: "rsa-release",
        publicKey: rsa.publicKey.export({ type: "spki", format: "pem" }).toString(),
        expires: "2026-12-01T00:00:00.000Z",
        revoked: false,
      }]]),
    },
    now,
  }), /invalid release-manifest signature/i);
});

test("accepted trust state rejects replay that would undo release-key revocation", () => {
  const revoked = trust({
    version: 4,
    releaseKeys: [{
      keyId: "fixture-release-2026",
      algorithm: "ed25519",
      publicKey: releasePublic,
      expires: "2026-12-01T00:00:00.000Z",
      revoked: true,
    }],
  });
  const acceptedAuthority = verifiedTrust(revoked);
  assert.deepEqual(Object.keys(acceptedAuthority.acceptedState).sort(), ["envelopeSha256", "version"]);
  assert.equal(acceptedAuthority.acceptedState.version, 4);

  assert.throws(
    () => verifyTrustMetadata(trust({ version: 3 }), {
      trustedRootKeys: new Map([["fixture-root-2026", rootPublic]]),
      now,
      accepted: acceptedAuthority.acceptedState,
    }),
    /trust metadata version replay/i,
  );
  assert.throws(
    () => verifyTrustMetadata(trust({ version: 4, channelUrl: "https://example.test/replayed-channel.json" }), {
      trustedRootKeys: new Map([["fixture-root-2026", rootPublic]]),
      now,
      accepted: acceptedAuthority.acceptedState,
    }),
    /equal trust metadata version is not an identical retry/i,
  );
  assert.equal(verifyTrustMetadata(revoked, {
    trustedRootKeys: new Map([["fixture-root-2026", rootPublic]]),
    now,
    accepted: acceptedAuthority.acceptedState,
  }).acceptedState.envelopeSha256, acceptedAuthority.acceptedState.envelopeSha256);
});

test("release-key expiry and revocation fail closed", () => {
  const expiredAuthority = verifiedTrust(trust({
    releaseKeys: [{
      keyId: "fixture-release-2026",
      algorithm: "ed25519",
      publicKey: releasePublic,
      expires: "2026-07-01T00:00:00.000Z",
      revoked: false,
    }],
  }), new Date("2026-06-01T00:00:00.000Z"));
  assert.throws(() => verifyReleaseManifest(manifest(), { trust: expiredAuthority, now }), /release key expired/i);

  const revokedAuthority = verifiedTrust(trust({
    releaseKeys: [{
      keyId: "fixture-release-2026",
      algorithm: "ed25519",
      publicKey: releasePublic,
      expires: "2026-12-01T00:00:00.000Z",
      revoked: true,
    }],
  }));
  assert.throws(() => verifyReleaseManifest(manifest(), { trust: revokedAuthority, now }), /release key revoked/i);
});

test("channel replay is rejected while an identical equal-sequence retry is accepted", () => {
  const authority = verifiedTrust();
  const releaseManifest = manifest();
  const current = channel(releaseManifest);
  const accepted = verifyChannel(current, { trust: authority, now, manifest: releaseManifest });

  assert.equal(verifyChannel(current, { trust: authority, now, manifest: releaseManifest, accepted }).sequence, 11);
  assert.throws(
    () => verifyChannel(channel(releaseManifest, { sequence: 10 }), { trust: authority, now, manifest: releaseManifest, accepted }),
    /channel sequence replay/i,
  );
  const different = manifest({ releaseId: "pi-v0.81.1-patch.7", tag: "pi-v0.81.1-patch.7" });
  assert.throws(
    () => verifyChannel(channel(different), { trust: authority, now, manifest: different, accepted }),
    /equal channel sequence is not an identical retry/i,
  );
});

test("equal Channel sequence rejects every non-identical envelope retry", () => {
  const authority = verifiedTrust();
  const releaseManifest = manifest();
  const current = channel(releaseManifest);
  const accepted = verifyChannel(current, { trust: authority, now, manifest: releaseManifest });

  for (const [name, retry] of [
    ["expiry", channel(releaseManifest, { expires: "2026-08-02T00:00:00.000Z" })],
    ["manifest URL", channel(releaseManifest, {
      manifest: { ...current.signed.manifest, url: "https://example.test/release-manifest.json" },
    })],
  ]) {
    assert.throws(
      () => verifyChannel(retry, { trust: authority, now, manifest: releaseManifest, accepted }),
      /equal Channel sequence is not an identical retry/i,
      name,
    );
  }

  const alternateTrust = verifiedTrust(trust({
    releaseKeys: [
      ...trust().signed.releaseKeys,
      {
        keyId: "fixture-release-alternate",
        algorithm: "ed25519",
        publicKey: readFileSync(join(keys, "unauthorized-public.pem"), "utf8"),
        expires: "2026-12-01T00:00:00.000Z",
        revoked: false,
      },
    ],
  }));
  const resigned = signMetadata(current.signed, "fixture-release-alternate", unauthorizedPrivate);
  assert.throws(
    () => verifyChannel(resigned, { trust: alternateTrust, now, manifest: releaseManifest, accepted }),
    /equal Channel sequence is not an identical retry/i,
  );
});

test("a patch-only promotion is a new channel selection", () => {
  const authority = verifiedTrust();
  const previous = manifest({ releaseId: "pi-v0.81.1-patch.5", tag: "pi-v0.81.1-patch.5" });
  const next = manifest();
  const previousChannel = channel(previous, { sequence: 10 });

  const selected = verifyChannel(channel(next), {
    trust: authority,
    now,
    manifest: next,
    accepted: verifyChannel(previousChannel, { trust: authority, now, manifest: previous }),
  });

  assert.equal(previous.signed.upstream.packageVersion, next.signed.upstream.packageVersion);
  assert.equal(selected.releaseId, "pi-v0.81.1-patch.6");
  assert.equal(selected.sequence, 11);
});

test("manifest projections are generated from one verified identity", () => {
  const signedManifest = manifest();
  const releaseManifest = verifyReleaseManifest(signedManifest, { trust: verifiedTrust(), now });
  const selectedChannel = channel(signedManifest);
  const archive = releaseManifest.platformArchives[0];

  assert.deepEqual(createArtifactManifest(releaseManifest), {
    schemaVersion: 1,
    releaseId: releaseManifest.releaseId,
    assets: [
      releaseManifest.manager.artifacts[0],
      releaseManifest.compatibility.questionTool.package,
      releaseManifest.bootstrap.installer,
      archive.artifact,
      releaseManifest.releaseGates[0].definition,
      releaseManifest.releaseGates[0].report,
      releaseManifest.releaseNotes,
    ].sort((left, right) => left.name.localeCompare(right.name)),
  });
  assert.match(createChecksums(releaseManifest), new RegExp(`${archive.artifact.sha256}  ${archive.artifact.name}`));
  assert.deepEqual(createArchiveMetadata(releaseManifest, "linux-x64"), {
    schemaVersion: 1,
    releaseId: releaseManifest.releaseId,
    upstream: releaseManifest.upstream,
    platform: "linux-x64",
    questionTool: {
      name: releaseManifest.compatibility.questionTool.name,
      version: releaseManifest.compatibility.questionTool.version,
    },
  });
  assert.deepEqual(createReceipt(releaseManifest, "linux-x64", "/managed/release"), {
    schemaVersion: 1,
    ownedPath: "/managed/release",
    releaseId: releaseManifest.releaseId,
    managerReleaseId: releaseManifest.manager.releaseId,
    platform: "linux-x64",
    payload: archive.payload,
  });
  assert.deepEqual(createCompatibilityActiveRelease(selectedChannel.signed, signedManifest), {
    schemaVersion: 1,
    generatedFrom: "release-channel",
    channelSequence: 11,
    releaseId: releaseManifest.releaseId,
    manifestSha256: selectedChannel.signed.manifest.sha256,
  });
});

test("the metadata CLI verifies provenance, signs a manifest, and promotes one Channel", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-metadata-cli-"));
  try {
    const unsignedPath = join(directory, "unsigned.json");
    const provenancePath = join(directory, "provenance.json");
    const trustPath = join(directory, "trust.json");
    const manifestPath = join(directory, "release-manifest.json");
    const output = join(directory, "promotion");
    const acceptedStatePath = join(directory, "accepted-state.json");
    const acceptedTrustStatePath = join(directory, "accepted-trust-state.json");
    const unsigned = manifest().signed;
    writeFileSync(unsignedPath, serializeMetadata(unsigned));
    writeFileSync(provenancePath, serializeMetadata(unsigned.provenance));
    writeFileSync(trustPath, serializeMetadata(trust()));
    writeFileSync(acceptedTrustStatePath, serializeMetadata(verifiedTrust().acceptedState));
    const previousChannel = channel(manifest(), { sequence: 10 });
    writeFileSync(acceptedStatePath, serializeMetadata(verifyChannel(previousChannel, {
      trust: verifiedTrust(),
      now,
      manifest: manifest(),
    })));

    const common = [
      "--trust", trustPath,
      "--root-key", `fixture-root-2026=${join(keys, "root-public.pem")}`,
      "--now", now.toISOString(),
      "--accepted-trust-state", acceptedTrustStatePath,
    ];
    const signed = spawnSync(process.execPath, [metadataCli, "sign-manifest",
      "--input", unsignedPath,
      "--provenance", provenancePath,
      ...common,
      "--key-id", "fixture-release-2026",
      "--private-key", join(keys, "release-private.pem"),
      "--output", manifestPath,
    ], { encoding: "utf8" });
    assert.equal(signed.status, 0, signed.stderr);

    const promoted = spawnSync(process.execPath, [metadataCli, "promote",
      "--manifest", manifestPath,
      ...common,
      "--key-id", "fixture-release-2026",
      "--private-key", join(keys, "release-private.pem"),
      "--sequence", "11",
      "--expires", "2026-08-01T00:00:00.000Z",
      "--manifest-url", "https://github.com/taylorrowser/pi-wait-for-user/releases/download/pi-v0.81.1-patch.6/release-manifest.json",
      "--accepted-state", acceptedStatePath,
      "--output", output,
    ], { encoding: "utf8" });
    assert.equal(promoted.status, 0, promoted.stderr);
    assert.equal(existsSync(join(output, "channel.json")), true);
    assert.deepEqual(JSON.parse(readFileSync(join(output, "trust-state.json"), "utf8")), verifiedTrust().acceptedState);
    assert.equal(existsSync(join(output, "active.json")), true);
    assert.equal(existsSync(join(output, "artifact-manifest.json")), true);
    assert.equal(existsSync(join(output, "SHA256SUMS")), true);
    const projectionOptions = [
      "--active", join(output, "active.json"),
      "--artifact-manifest", join(output, "artifact-manifest.json"),
      "--checksums", join(output, "SHA256SUMS"),
      "--archive-metadata-dir", output,
    ];
    const verified = spawnSync(process.execPath, [metadataCli, "verify",
      "--manifest", manifestPath,
      "--channel", join(output, "channel.json"),
      ...common,
      ...projectionOptions,
    ], { encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr);

    const receiptPath = join(directory, "receipt.json");
    const receipt = spawnSync(process.execPath, [metadataCli, "receipt",
      "--manifest", manifestPath,
      ...common,
      "--platform", "linux-x64",
      "--owned-path", "/managed/release",
      "--output", receiptPath,
    ], { encoding: "utf8" });
    assert.equal(receipt.status, 0, receipt.stderr);
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), createReceipt(
      verifyReleaseManifest(manifest(), { trust: verifiedTrust(), now }),
      "linux-x64",
      "/managed/release",
    ));

    const activePath = join(output, "active.json");
    writeFileSync(activePath, serializeMetadata({ ...JSON.parse(readFileSync(activePath, "utf8")), releaseId: "pi-v0.81.1-patch.5" }));
    const drifted = spawnSync(process.execPath, [metadataCli, "verify",
      "--manifest", manifestPath,
      "--channel", join(output, "channel.json"),
      ...common,
      ...projectionOptions,
    ], { encoding: "utf8" });
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /active\.json projection drift/i);

    writeFileSync(provenancePath, serializeMetadata({ ...unsigned.provenance, repository: "attacker/fork" }));
    const rejected = spawnSync(process.execPath, [metadataCli, "sign-manifest",
      "--input", unsignedPath,
      "--provenance", provenancePath,
      ...common,
      "--key-id", "fixture-release-2026",
      "--private-key", join(keys, "release-private.pem"),
      "--output", join(directory, "rejected.json"),
    ], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /provenance repository mismatch/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production signing is tag-only, delegated, protected, and stages stable state after immutable publication", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  const policy = JSON.parse(readFileSync(join(root, "releases", "signing-policy.json"), "utf8"));
  const secretNames = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)].map((match) => match[1]);

  assert.deepEqual(secretNames, ["RELEASE_SIGNING_PRIVATE_KEY"]);
  assert.doesNotMatch(workflow, /ROOT_PRIVATE|RELEASE_ROOT_PUBLIC_KEY/);
  assert.match(workflow, /production-release:\n\s+if: startsWith\(github\.ref, 'refs\/tags\/'\)/);
  assert.match(workflow, /environment: production-release/);
  assert.match(workflow, /origin\/main:releases\/\$file/);
  assert.match(workflow, /--trust "\$AUTHORITY_DIR\/release-trust\.json"/);
  assert.equal(workflow.match(/test "\$\(git rev-parse origin\/main\)" = "\$AUTHORITY_COMMIT"/g)?.length, 2);
  assert.match(workflow, /if \(requested > current\)/);
  assert.match(workflow, /policy\.validity\.channelDays \* 86400000/);
  assert.doesNotMatch(workflow, /59 \* 86400000/);
  assert.ok(
    workflow.indexOf("Publish immutable GitHub release") < workflow.indexOf("Stage the atomic stable-Channel promotion branch"),
  );
  for (const file of ["channel.json", "channel-state.json", "trust-state.json"]) {
    assert.match(workflow, new RegExp(`cp .*${file.replace(".", "\\.")}.* releases/${file.replace(".", "\\.")}`));
  }
  assert.equal(policy.githubEnvironment, "production-release");
  assert.equal(policy.stableUrls.trust.endsWith("/releases/release-trust.json"), true);
  assert.equal(policy.stableUrls.channel.endsWith("/releases/channel.json"), true);
  assert.deepEqual(policy.initialKeyIds, { root: "root-2026-1", release: "release-2026-1" });
  assert.deepEqual(policy.validity, {
    trustMonths: 18,
    releaseKeyDays: 180,
    channelDays: 60,
    releaseKeyRotationLeadDays: 45,
  });
});

test("the fixture ceremony signs, rotates, revokes, and independently verifies release trust", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-trust-ceremony-"));
  try {
    writeFileSync(join(directory, "root-public.pem"), rootPublic);
    writeFileSync(join(directory, "release-public.pem"), releasePublic);
    writeFileSync(join(directory, "next-release-public.pem"), readFileSync(join(keys, "unauthorized-public.pem"), "utf8"));
    const rootArgument = `fixture-root-2026=${join(directory, "root-public.pem")}`;
    const signInput = (name, value, output) => {
      const input = join(directory, `${name}.json`);
      writeFileSync(input, serializeMetadata(value));
      const result = spawnSync(process.execPath, [metadataCli, "sign-trust",
        "--input", input,
        "--root-key-id", "fixture-root-2026",
        "--root-private-key", join(keys, "root-private.pem"),
        "--root-public-key", join(directory, "root-public.pem"),
        "--now", now.toISOString(),
        "--output", output,
      ], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /PRIVATE KEY/);
      return JSON.parse(readFileSync(output, "utf8"));
    };
    const input = (version, releaseKeys) => ({
      schemaVersion: 1,
      type: "release-trust",
      version,
      expires: "2027-12-01T00:00:00.000Z",
      channelUrl: "https://raw.githubusercontent.com/taylorrowser/pi-wait-for-user/main/releases/channel.json",
      releaseKeys,
    });
    const oldKey = {
      keyId: "fixture-release-2026",
      algorithm: "ed25519",
      publicKeyFile: "release-public.pem",
      expires: "2027-01-01T00:00:00.000Z",
      revoked: false,
    };
    const nextKey = {
      keyId: "fixture-release-next",
      algorithm: "ed25519",
      publicKeyFile: "next-release-public.pem",
      expires: "2027-06-01T00:00:00.000Z",
      revoked: false,
    };

    const initial = signInput("initial-input", input(1, [oldKey]), join(directory, "initial-trust.json"));
    const initialAuthority = verifyTrustMetadata(initial, {
      trustedRootKeys: new Map([["fixture-root-2026", rootPublic]]),
      now,
    });
    const rotated = signInput("rotation-input", input(2, [oldKey, nextKey]), join(directory, "rotated-trust.json"));
    const rotatedAuthority = verifyTrustMetadata(rotated, {
      trustedRootKeys: new Map([["fixture-root-2026", rootPublic]]),
      now,
      accepted: initialAuthority.acceptedState,
    });
    const rotatedManifest = signMetadata(manifest().signed, "fixture-release-next", unauthorizedPrivate);
    const rotatedChannel = signMetadata(channel(rotatedManifest).signed, "fixture-release-next", unauthorizedPrivate);
    assert.equal(verifyReleaseManifest(rotatedManifest, { trust: rotatedAuthority, now }).releaseId, "pi-v0.81.1-patch.6");
    assert.equal(verifyChannel(rotatedChannel, {
      trust: rotatedAuthority,
      now,
      manifest: rotatedManifest,
    }).sequence, 11);

    const revoked = signInput("revocation-input", input(3, [
      { ...oldKey, revoked: true },
      nextKey,
    ]), join(directory, "revoked-trust.json"));
    const revokedAuthority = verifyTrustMetadata(revoked, {
      trustedRootKeys: new Map([["fixture-root-2026", rootPublic]]),
      now,
      accepted: rotatedAuthority.acceptedState,
    });
    assert.throws(
      () => verifyReleaseManifest(manifest(), { trust: revokedAuthority, now }),
      /release key revoked/i,
    );
    assert.equal(verifyChannel(rotatedChannel, {
      trust: revokedAuthority,
      now,
      manifest: rotatedManifest,
    }).releaseId, "pi-v0.81.1-patch.6");

    const verified = spawnSync(process.execPath, [metadataCli, "verify-trust",
      "--trust", join(directory, "revoked-trust.json"),
      "--root-key", rootArgument,
      "--now", now.toISOString(),
    ], { encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /verified release trust metadata version 3/i);
    assert.match(verified.stdout, /[a-f0-9]{64}/);

    const fingerprint = spawnSync(process.execPath, [metadataCli, "fingerprint",
      "--public-key", join(directory, "root-public.pem"),
    ], { encoding: "utf8" });
    assert.equal(fingerprint.status, 0, fingerprint.stderr);
    assert.match(fingerprint.stdout, /^[a-f0-9]{64}\n$/);

    writeFileSync(join(directory, "unsafe-input.json"), serializeMetadata(input(4, [{
      ...nextKey,
      publicKeyFile: "root-private.pem",
    }])));
    writeFileSync(join(directory, "root-private.pem"), rootPrivate);
    const unsafe = spawnSync(process.execPath, [metadataCli, "sign-trust",
      "--input", join(directory, "unsafe-input.json"),
      "--root-key-id", "fixture-root-2026",
      "--root-private-key", join(keys, "root-private.pem"),
      "--root-public-key", join(directory, "root-public.pem"),
      "--now", now.toISOString(),
      "--output", join(directory, "unsafe-trust.json"),
    ], { encoding: "utf8" });
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /expected an SPKI public key/i);
    assert.equal(existsSync(join(directory, "unsafe-trust.json")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("digest, extracted-file, projection drift, and provenance mismatches are rejected", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-metadata-payload-"));
  try {
    mkdirSync(join(directory, "pi-wait-for-user"));
    writeFileSync(join(directory, "pi-wait-for-user", "pi-core"), "binary");
    chmodSync(join(directory, "pi-wait-for-user", "pi-core"), 0o755);
    writeFileSync(join(directory, "pi-wait-for-user", "release.json"), "metadata");
    const releaseManifest = verifyReleaseManifest(manifest(), { trust: verifiedTrust(), now });
    const archive = releaseManifest.platformArchives[0];

    assert.deepEqual(createPayloadInventory(directory), archive.payload);
    verifyReleasePayloads(directory, archive.payload);
    writeFileSync(join(directory, "pi-wait-for-user", "pi-core"), "broken");
    assert.throws(() => verifyReleasePayloads(directory, archive.payload), /payload digest mismatch/i);
    writeFileSync(join(directory, "pi-wait-for-user", "pi-core"), "binary");
    chmodSync(join(directory, "pi-wait-for-user", "pi-core"), 0o700);
    assert.throws(() => verifyReleasePayloads(directory, archive.payload), /payload mode mismatch/i);

    assert.throws(
      () => createArtifactManifest({ ...releaseManifest, releaseNotes: { ...releaseManifest.releaseNotes, sha256: "0".repeat(64) } }, {
        existing: createArtifactManifest(releaseManifest),
      }),
      /artifact-manifest\.json projection drift/i,
    );
    assert.throws(
      () => verifyProvenance(releaseManifest, {
        repository: "attacker/fork",
        workflow: releaseManifest.provenance.workflow,
        sourceCommit: releaseManifest.provenance.sourceCommit,
        artifacts: releaseManifest.provenance.artifacts,
      }),
      /provenance repository mismatch/i,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
