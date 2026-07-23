import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  lstatSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  acquirePairLease,
  cleanupManagedState,
  defaultManagedBinDirectory,
  defaultManagedDataRoot,
  installAndActivate,
  readActivation,
  readLegacyMigration,
  readManagedOwnership,
  removeInstalledPair,
  verifyManagedInstallation,
  withLifecycleLock,
} from "../scripts/lib/managed-runtime.mjs";
import {
  createPayloadInventory,
  serializeMetadata,
  signMetadata,
} from "../scripts/lib/release-metadata.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dispatcher = join(repositoryRoot, "scripts", "managed-dispatcher.mjs");
const managerCli = join(repositoryRoot, "scripts", "managed-manager.mjs");
const managedInstaller = join(repositoryRoot, "scripts", "managed-installer.mjs");
const keys = join(repositoryRoot, "test", "fixtures", "release-keys");
const rootPrivate = readFileSync(join(keys, "root-private.pem"), "utf8");
const rootPublic = readFileSync(join(keys, "root-public.pem"), "utf8");
const releasePrivate = readFileSync(join(keys, "release-private.pem"), "utf8");
const releasePublic = readFileSync(join(keys, "release-public.pem"), "utf8");
const now = new Date("2026-07-24T12:00:00.000Z");

function destroy(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isSymbolicLink() && stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) destroy(join(path, name));
    rmSync(path, { recursive: true, force: true });
  } else {
    if (!stat.isSymbolicLink()) chmodSync(path, 0o600);
    rmSync(path, { force: true });
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(path) {
  const bytes = readFileSync(path);
  return { name: basename(path), sha256: digest(bytes), size: bytes.length };
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function archive(source, output) {
  const result = spawnSync("tar", ["-czf", output, "-C", source, "."], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function metadataArtifact(name, contents) {
  return { name, sha256: digest(contents), size: Buffer.byteLength(contents) };
}

function fixture({ releaseId = "pi-v0.81.1-patch.6", managerId = "manager-v1", managerArchive: providedManagerArchive } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "managed-runtime-fixture-"));
  const managerPayload = join(directory, "manager-payload");
  const releasePayload = join(directory, "release-payload");
  mkdirSync(join(managerPayload, "package", "scripts", "lib"), { recursive: true });
  mkdirSync(join(releasePayload, "pi-wait-for-user", "question-tool", "extensions"), { recursive: true });
  cpSync(dispatcher, join(managerPayload, "package", "scripts", "managed-dispatcher.mjs"));
  cpSync(managerCli, join(managerPayload, "package", "scripts", "managed-manager.mjs"));
  cpSync(join(repositoryRoot, "scripts", "lib", "managed-command.mjs"), join(managerPayload, "package", "scripts", "lib", "managed-command.mjs"));
  cpSync(join(repositoryRoot, "scripts", "lib", "managed-runtime.mjs"), join(managerPayload, "package", "scripts", "lib", "managed-runtime.mjs"));
  cpSync(join(repositoryRoot, "scripts", "lib", "release-metadata.mjs"), join(managerPayload, "package", "scripts", "lib", "release-metadata.mjs"));

  writeExecutable(join(managerPayload, "package", "manager"), `#!/bin/sh
set -eu
directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${process.execPath}" "$directory/scripts/managed-manager.mjs" "$@"
`);
  writeFileSync(join(managerPayload, "package", "package.json"), `${JSON.stringify({
    name: "fixture-manager",
    version: "1.0.0",
    piWaitForUser: { managerReleaseId: managerId, compatibleReleaseManifestVersions: [1] },
  }, null, 2)}\n`);

  writeExecutable(join(releasePayload, "pi-wait-for-user", "pi-core"), `#!/bin/sh
case "\${1:-}" in
  --version) echo "0.81.1" ;;
  --help) echo "Pi fixture help" ;;
  conformance) echo "Deferred conformance passed (8/8)" ;;
  *) printf 'PI_ARGS:'; printf ' <%s>' "$@"; printf '\n' ;;
esac
`);
  writeFileSync(join(releasePayload, "pi-wait-for-user", "question-tool", "extensions", "question-tool.ts"), "export {};\n");
  writeFileSync(join(releasePayload, "pi-wait-for-user", "question-tool", "package.json"), `${JSON.stringify({
    name: "@taylorrowser/pi-question-tool",
    version: "0.1.3",
    piWaitForUser: {
      coreProtocolVersions: [1],
      handlerId: "dev.taylorrowser.pi-question-tool.question",
      handlerVersion: 1,
      packageSchemaVersions: [1],
    },
  }, null, 2)}\n`);
  writeFileSync(join(releasePayload, "pi-wait-for-user", "release.json"), `${JSON.stringify({
    schemaVersion: 1,
    releaseId,
    platform: "linux-x64",
  }, null, 2)}\n`);

  const managerArchive = providedManagerArchive || join(directory, `${managerId}.tar.gz`);
  const releaseArchive = join(directory, `${releaseId}-linux-x64.tar.gz`);
  if (!providedManagerArchive) archive(managerPayload, managerArchive);
  archive(releasePayload, releaseArchive);

  const manager = artifact(managerArchive);
  const downstream = artifact(releaseArchive);
  const questionPackage = metadataArtifact("question-tool.tgz", "question package");
  const installer = metadataArtifact("install.sh", "installer");
  const definition = metadataArtifact("fixture-gate.json", "gate");
  const report = metadataArtifact("release-candidate.json", "passed");
  const notes = metadataArtifact("RELEASE_NOTES.md", "notes");
  const trustEnvelope = signMetadata({
    schemaVersion: 1,
    type: "release-trust",
    version: 3,
    expires: "2027-01-01T00:00:00.000Z",
    channelUrl: "https://example.test/channel.json",
    releaseKeys: [{
      keyId: "fixture-release",
      algorithm: "ed25519",
      publicKey: releasePublic,
      expires: "2026-12-01T00:00:00.000Z",
      revoked: false,
    }],
  }, "fixture-root", rootPrivate);
  const manifestEnvelope = signMetadata({
    schemaVersion: 1,
    type: "release-manifest",
    releaseId,
    tag: releaseId,
    publishedAt: "2026-07-24T10:00:00.000Z",
    upstream: {
      repository: "https://github.com/earendil-works/pi.git",
      tag: "v0.81.1",
      commit: "20be4b18d4c57487f8993d2762bace129f0cf7c6",
      packageVersion: "0.81.1",
    },
    patches: [{ order: 1, path: "patches/active/0001.patch", sha256: digest("patch"), size: 5 }],
    compatibility: {
      questionTool: {
        name: "@taylorrowser/pi-question-tool",
        version: "0.1.3",
        manifest: metadataArtifact("packages/question-tool/package.json", "question manifest"),
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
    manager: { releaseId: managerId, compatibleReleaseManifestVersions: [1], artifacts: [manager] },
    bootstrap: { installer },
    platformArchives: [{ platform: "linux-x64", artifact: downstream, payload: createPayloadInventory(releasePayload) }],
    releaseGates: [{ name: "release-candidate", status: "passed", definition, report }],
    provenance: {
      repository: "taylorrowser/pi-wait-for-user",
      workflow: ".github/workflows/release.yml",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      artifacts: [manager, questionPackage, installer, definition, downstream, report, notes]
        .map(({ name, sha256 }) => ({ name, sha256 }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    },
    releaseNotes: notes,
  }, "fixture-release", releasePrivate);
  const channelEnvelope = signMetadata({
    schemaVersion: 1,
    type: "release-channel",
    sequence: Number(releaseId.match(/patch\.(\d+)$/)?.[1] ?? 1),
    expires: "2026-08-01T00:00:00.000Z",
    manifest: {
      releaseId,
      url: `https://example.test/${releaseId}/release-manifest.json`,
      sha256: digest(serializeMetadata(manifestEnvelope)),
    },
  }, "fixture-release", releasePrivate);

  return {
    directory,
    managerArchive,
    releaseArchive,
    trustEnvelope,
    channelEnvelope,
    manifestEnvelope,
    rootKeys: new Map([["fixture-root", rootPublic]]),
  };
}

function activate(dataRoot, candidate, options = {}) {
  const { callerSelected = false, ...activationOptions } = options;
  const request = {
    dataRoot,
    platform: "linux-x64",
    now,
    ...candidate,
    ...activationOptions,
  };
  const result = installAndActivate(request);
  if (!callerSelected) {
    const configPath = join(dataRoot, "state", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.rootKeyProvenance.type = "installer-pinned";
    writeFileSync(configPath, serializeMetadata(config));
  }
  return result;
}

function runManagedCli(executable, dataRoot, args, environment = {}) {
  const { PI_TEST_CWD, ...environmentOverrides } = environment;
  return spawnSync(process.execPath, [executable, ...args], {
    encoding: "utf8",
    cwd: PI_TEST_CWD,
    env: { ...process.env, PI_MANAGED_DATA_ROOT: dataRoot, PI_MANAGED_PLATFORM: "linux-x64", ...environmentOverrides },
  });
}

function runDispatcher(dataRoot, args, environment = {}) {
  return runManagedCli(dispatcher, dataRoot, args, environment);
}

function runManager(dataRoot, args, environment = {}) {
  return runManagedCli(managerCli, dataRoot, args, environment);
}

test("one atomic Activation selects an immutable compatible pair and dispatches Pi through its Question Tool", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-state-"));
  const candidate = fixture();
  try {
    activate(dataRoot, candidate);
    const selected = readActivation(dataRoot);
    assert.equal(selected.active.managerReleaseId, "manager-v1");
    assert.equal(selected.active.downstreamReleaseId, "pi-v0.81.1-patch.6");
    assert.equal(selected.previous, null);

    const launched = runDispatcher(dataRoot, ["--model", "fixture"]);
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stdout, /PI_ARGS: <-e> <.*question-tool> <--model> <fixture>/);

    assert.equal((readFileSync(join(dataRoot, "managers", "manager-v1", "package", "manager"))).length > 0, true);
    assert.throws(() => writeFileSync(join(dataRoot, "downstream-releases", "pi-v0.81.1-patch.6", "foreign"), "x"), /EACCES|EPERM/);
  } finally {
    destroy(dataRoot);
    destroy(candidate.directory);
  }
});

test("a patch-only Activation reuses one exact immutable Manager Release", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-patch-only-"));
  const previous = fixture({ releaseId: "pi-v0.81.1-patch.5" });
  const next = fixture({ managerArchive: previous.managerArchive });
  try {
    activate(dataRoot, previous);
    activate(dataRoot, next);
    const activation = readActivation(dataRoot);
    assert.equal(activation.active.managerReleaseId, "manager-v1");
    assert.equal(activation.previous.managerReleaseId, "manager-v1");
    assert.equal(verifyManagedInstallation(dataRoot, { all: true }).length, 2);
  } finally {
    destroy(dataRoot);
    destroy(previous.directory);
    destroy(next.directory);
  }
});

test("every publish/switch interruption exposes the complete old or new pair and retains the previous successful pair", () => {
  const boundaries = [
    "manager-staged",
    "downstream-staged",
    "metadata-accepted",
    "manager-published",
    "downstream-published",
    "before-activation-switch",
    "after-activation-switch",
  ];
  for (const boundary of boundaries) {
    const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-crash-"));
    const oldCandidate = fixture({ releaseId: "pi-v0.81.1-patch.5" });
    const nextCandidate = fixture({ managerId: "manager-v2" });
    try {
      activate(dataRoot, oldCandidate);
      assert.throws(() => activate(dataRoot, nextCandidate, {
        checkpoint(name) {
          if (name === boundary) throw new Error(`interrupted at ${name}`);
        },
      }), new RegExp(boundary));
      const activation = readActivation(dataRoot);
      const switched = boundary === "after-activation-switch";
      assert.equal(activation.active.downstreamReleaseId, switched ? "pi-v0.81.1-patch.6" : "pi-v0.81.1-patch.5", boundary);
      assert.equal(activation.previous?.downstreamReleaseId, switched ? "pi-v0.81.1-patch.5" : undefined, boundary);
      assert.doesNotThrow(() => verifyManagedInstallation(dataRoot));
    } finally {
      destroy(dataRoot);
      destroy(oldCandidate.directory);
      destroy(nextCandidate.directory);
    }
  }
});

test("launch fails closed for malformed state, pair mismatch, foreign paths, and tampered receipts without running Stock Pi", () => {
  const mutations = [
    ["malformed state", (root) => writeFileSync(join(root, "state", "activation.json"), "{}\n")],
    ["pair mismatch", (root) => {
      const path = join(root, "state", "activation.json");
      const value = JSON.parse(readFileSync(path, "utf8"));
      value.active.managerReleaseId = "manager-foreign";
      writeFileSync(path, JSON.stringify(value));
    }],
    ["symlinked state", (root) => {
      const path = join(root, "state", "activation.json");
      const target = join(root, "activation-target.json");
      writeFileSync(target, readFileSync(path));
      rmSync(path);
      symlinkSync(target, path);
    }],
    ["foreign path", (root) => {
      const path = join(root, "receipts", "managers", "manager-v1.json");
      const value = JSON.parse(readFileSync(path, "utf8"));
      value.ownedPath = "/tmp/foreign";
      writeFileSync(path, JSON.stringify(value));
    }],
    ["tampered receipt", (root) => {
      const path = join(root, "receipts", "releases", "pi-v0.81.1-patch.6.json");
      const value = JSON.parse(readFileSync(path, "utf8"));
      value.platform = "darwin-arm64";
      writeFileSync(path, JSON.stringify(value));
    }],
    ["symlinked receipt directory", (root) => {
      const receiptDirectory = join(root, "receipts", "managers");
      const foreignDirectory = join(root, "foreign-manager-receipts");
      mkdirSync(foreignDirectory);
      writeFileSync(
        join(foreignDirectory, "manager-v1.json"),
        readFileSync(join(receiptDirectory, "manager-v1.json")),
      );
      rmSync(receiptDirectory, { recursive: true });
      symlinkSync(foreignDirectory, receiptDirectory);
    }],
  ];
  for (const [name, mutate] of mutations) {
    const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-invalid-"));
    const candidate = fixture();
    try {
      activate(dataRoot, candidate);
      mutate(dataRoot);
      const launched = runDispatcher(dataRoot, []);
      assert.notEqual(launched.status, 0, name);
      assert.match(launched.stderr, /recover --previous/);
      assert.match(launched.stderr, /managed disable/);
      assert.doesNotMatch(launched.stdout, /PI_ARGS/);
    } finally {
      destroy(dataRoot);
      destroy(candidate.directory);
    }
  }
});

test("full verification detects payload changes; --all verifies the retained previous pair", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-verify-"));
  const oldCandidate = fixture({ releaseId: "pi-v0.81.1-patch.5" });
  const nextCandidate = fixture({ managerId: "manager-v2" });
  try {
    activate(dataRoot, oldCandidate);
    activate(dataRoot, nextCandidate);
    assert.equal(verifyManagedInstallation(dataRoot, { all: true }).length, 2);
    const cliVerification = spawnSync(process.execPath, [managerCli, "managed", "verify", "--all", "--data-root", dataRoot], {
      encoding: "utf8",
    });
    assert.equal(cliVerification.status, 0, cliVerification.stderr);
    assert.match(cliVerification.stdout, /Verified 2 managed Activation pairs/);
    chmodSync(join(dataRoot, "downstream-releases", "pi-v0.81.1-patch.5", "pi-wait-for-user", "release.json"), 0o644);
    writeFileSync(join(dataRoot, "downstream-releases", "pi-v0.81.1-patch.5", "pi-wait-for-user", "release.json"), "tampered\n");
    assert.doesNotThrow(() => verifyManagedInstallation(dataRoot));
    assert.throws(
      () => verifyManagedInstallation(dataRoot, { all: true }),
      /Downstream Release metadata|payload (size|digest) mismatch/i,
    );

    const activeArtifact = nextCandidate.manifestEnvelope.signed.platformArchives[0].artifact;
    const cachedArtifact = join(dataRoot, "artifacts", activeArtifact.sha256);
    chmodSync(cachedArtifact, 0o600);
    writeFileSync(cachedArtifact, "tampered archive\n");
    assert.throws(() => verifyManagedInstallation(dataRoot), /cached downstream release artifact (size|digest) mismatch/i);
  } finally {
    destroy(dataRoot);
    destroy(oldCandidate.directory);
    destroy(nextCandidate.directory);
  }
});

test("optional online provenance verification audits both selected payload artifacts", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-provenance-"));
  const candidate = fixture();
  const fakeGhRoot = mkdtempSync(join(tmpdir(), "managed-runtime-gh-"));
  const calls = join(fakeGhRoot, "calls.txt");
  const fakeGh = join(fakeGhRoot, "gh");
  try {
    activate(dataRoot, candidate);
    writeExecutable(fakeGh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\n`);
    assert.equal(verifyManagedInstallation(dataRoot, { provenance: true, gh: fakeGh }).length, 1);
    const argumentsUsed = readFileSync(calls, "utf8");
    assert.equal(argumentsUsed.split("\n").filter(Boolean).length, 2);
    assert.match(argumentsUsed, /--repo taylorrowser\/pi-wait-for-user/);
    assert.match(argumentsUsed, /--source-digest 0123456789abcdef0123456789abcdef01234567/);
  } finally {
    destroy(dataRoot);
    destroy(candidate.directory);
    destroy(fakeGhRoot);
  }
});

test("activation rejects malformed accepted metadata state instead of resetting replay checkpoints", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-accepted-state-"));
  const active = fixture();
  const replay = fixture({
    releaseId: "pi-v0.81.1-patch.5",
    managerArchive: active.managerArchive,
  });
  try {
    activate(dataRoot, active);
    writeFileSync(join(dataRoot, "state", "accepted-metadata.json"), "{}\n");

    assert.throws(() => activate(dataRoot, replay), /Malformed accepted metadata state/);
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.6");
  } finally {
    destroy(dataRoot);
    destroy(active.directory);
    destroy(replay.directory);
  }
});

test("activation rejects missing replay checkpoints for an existing Activation", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-missing-accepted-state-"));
  const active = fixture();
  const replay = fixture({
    releaseId: "pi-v0.81.1-patch.5",
    managerArchive: active.managerArchive,
  });
  try {
    activate(dataRoot, active);
    rmSync(join(dataRoot, "state", "accepted-metadata.json"));

    assert.throws(() => activate(dataRoot, replay), /Accepted metadata state is missing for existing Activation/);
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.6");
  } finally {
    destroy(dataRoot);
    destroy(active.directory);
    destroy(replay.directory);
  }
});

test("activation rejects a symlink-substituted cached artifact before publication", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-artifact-symlink-"));
  const candidate = fixture();
  try {
    const managerArtifact = candidate.manifestEnvelope.signed.manager.artifacts[0];
    mkdirSync(join(dataRoot, "artifacts"), { recursive: true });
    symlinkSync(candidate.managerArchive, join(dataRoot, "artifacts", managerArtifact.sha256));

    assert.throws(() => activate(dataRoot, candidate), /Cached artifact.*regular file/i);
    assert.equal(existsSync(join(dataRoot, "state", "activation.json")), false);
  } finally {
    destroy(dataRoot);
    destroy(candidate.directory);
  }
});

test("full verification derives Manager Release payload identity from its signed artifact", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-manager-tamper-"));
  const candidate = fixture();
  try {
    activate(dataRoot, candidate);
    const managerPath = join(dataRoot, "managers", "manager-v1", "package", "manager");
    const tamperedManager = "#!/bin/sh\nif [ \"$1\" = \"--manager-version\" ]; then echo manager-v1; fi\n";
    writeExecutable(managerPath, tamperedManager);

    const centralReceipt = join(dataRoot, "receipts", "managers", "manager-v1.json");
    const embeddedReceipt = join(dataRoot, "managers", "manager-v1", ".managed", "receipt.json");
    const receipt = JSON.parse(readFileSync(centralReceipt, "utf8"));
    const managerEntry = receipt.payload.find((entry) => entry.path === "package/manager");
    managerEntry.sha256 = digest(tamperedManager);
    managerEntry.size = Buffer.byteLength(tamperedManager);
    managerEntry.mode = 0o755;
    const tamperedReceipt = serializeMetadata(receipt);
    writeFileSync(centralReceipt, tamperedReceipt);
    writeFileSync(embeddedReceipt, tamperedReceipt);

    assert.throws(() => verifyManagedInstallation(dataRoot), /Manager Release payload|Payload (?:size|digest) mismatch/i);
  } finally {
    destroy(dataRoot);
    destroy(candidate.directory);
  }
});

test("unknown trust, Channel, and Release Manifest schemas leave the active pair launchable", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-schema-"));
  const active = fixture({ releaseId: "pi-v0.81.1-patch.5" });
  const candidates = [
    ["release-trust", "trustEnvelope"],
    ["release-channel", "channelEnvelope"],
    ["release-manifest", "manifestEnvelope"],
  ].map(([type, field]) => ({ type, field, candidate: fixture({ managerId: `manager-${type}` }) }));
  try {
    activate(dataRoot, active);
    for (const { type, field, candidate } of candidates) {
      candidate[field].signed.schemaVersion = 99;
      assert.throws(() => activate(dataRoot, candidate), new RegExp(`unknown ${type} schema version 99`, "i"));
      const launched = runDispatcher(dataRoot, []);
      assert.equal(launched.status, 0, launched.stderr);
      assert.match(launched.stdout, /PI_ARGS/);
    }
  } finally {
    destroy(dataRoot);
    destroy(active.directory);
    for (const { candidate } of candidates) destroy(candidate.directory);
  }
});

test("stage-0 recovers the verified previous pair without the active manager", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-recover-"));
  const oldCandidate = fixture({ releaseId: "pi-v0.81.1-patch.5" });
  const nextCandidate = fixture({ managerId: "manager-v2" });
  try {
    activate(dataRoot, oldCandidate);
    activate(dataRoot, nextCandidate);
    chmodSync(join(dataRoot, "managers", "manager-v2", "package", "manager"), 0o644);
    const failed = runDispatcher(dataRoot, []);
    assert.notEqual(failed.status, 0);
    chmodSync(join(dataRoot, "managers", "manager-v2", "package", "manager"), 0o555);
    const recovered = runDispatcher(dataRoot, ["managed", "recover", "--previous"]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.5");
  } finally {
    destroy(dataRoot);
    destroy(oldCandidate.directory);
    destroy(nextCandidate.directory);
  }
});

test("the lifecycle lock serializes mutations while normal launches continue", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-lock-"));
  const candidate = fixture();
  try {
    activate(dataRoot, candidate);
    withLifecycleLock(dataRoot, "first activation", () => {
      assert.throws(
        () => withLifecycleLock(dataRoot, "second activation", () => {}),
        /first activation/,
      );
      const launched = runDispatcher(dataRoot, ["--help"]);
      assert.equal(launched.status, 0, launched.stderr);
    });
  } finally {
    destroy(dataRoot);
    destroy(candidate.directory);
  }
});

test("leased payload cleanup is deferred and receipt-scoped cleanup rejects foreign paths", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-cleanup-"));
  const old = fixture({ releaseId: "pi-v0.81.1-patch.4" });
  const previous = fixture({ releaseId: "pi-v0.81.1-patch.5", managerId: "manager-v2" });
  const active = fixture({ managerId: "manager-v3" });
  try {
    activate(dataRoot, old);
    const oldPair = readActivation(dataRoot).active;
    activate(dataRoot, previous);
    activate(dataRoot, active);

    mkdirSync(join(dataRoot, "tmp", "foreign.tmp"), { recursive: true });
    writeFileSync(join(dataRoot, "tmp", "foreign.tmp", "keep"), "foreign");
    cleanupManagedState(dataRoot);
    assert.equal(existsSync(join(dataRoot, "tmp", "foreign.tmp", "keep")), true);

    const lease = acquirePairLease(dataRoot, oldPair);
    assert.equal(removeInstalledPair(dataRoot, oldPair), "deferred");
    assert.equal(existsSync(join(dataRoot, "downstream-releases", oldPair.downstreamReleaseId)), true);
    lease.release();
    assert.equal(cleanupManagedState(dataRoot) >= 1, true);
    assert.equal(existsSync(join(dataRoot, "downstream-releases", oldPair.downstreamReleaseId)), false);
    assert.equal(existsSync(join(dataRoot, "state", "pending-cleanup.json")), false);
  } finally {
    destroy(dataRoot);
    destroy(old.directory);
    destroy(previous.directory);
    destroy(active.directory);
  }
});

test("leased cleanup retries converge after a tombstone was removed before its central receipts", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-cleanup-retry-"));
  const old = fixture({ releaseId: "pi-v0.81.1-patch.4" });
  const previous = fixture({ releaseId: "pi-v0.81.1-patch.5", managerId: "manager-v2" });
  const active = fixture({ managerId: "manager-v3" });
  try {
    activate(dataRoot, old);
    const oldPair = readActivation(dataRoot).active;
    activate(dataRoot, previous);
    activate(dataRoot, active);

    destroy(join(dataRoot, "downstream-releases", oldPair.downstreamReleaseId));
    writeFileSync(join(dataRoot, "state", "pending-cleanup.json"), serializeMetadata({
      schemaVersion: 1,
      pairs: [oldPair],
    }));

    assert.equal(cleanupManagedState(dataRoot) >= 1, true);
    assert.equal(existsSync(join(dataRoot, "receipts", "releases", `${oldPair.downstreamReleaseId}.json`)), false);
    assert.equal(existsSync(join(dataRoot, "managers", oldPair.managerReleaseId)), false);
    assert.equal(existsSync(join(dataRoot, "receipts", "managers", `${oldPair.managerReleaseId}.json`)), false);
    assert.equal(existsSync(join(dataRoot, "state", "pending-cleanup.json")), false);
  } finally {
    destroy(dataRoot);
    destroy(old.directory);
    destroy(previous.directory);
    destroy(active.directory);
  }
});

test("signed-payload-identical legacy installation is adopted only after complete verification", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-legacy-adopt-"));
  const candidate = fixture();
  const extracted = join(candidate.directory, "legacy-extracted");
  const legacy = join(candidate.directory, "custom-legacy-installation");
  try {
    mkdirSync(extracted);
    assert.equal(spawnSync("tar", ["-xzf", candidate.releaseArchive, "-C", extracted]).status, 0);
    cpSync(join(extracted, "pi-wait-for-user"), legacy, { recursive: true });

    activate(dataRoot, candidate, { legacyDirectories: [legacy] });
    const migration = readLegacyMigration(dataRoot);
    assert.equal(migration.disposition, "adopted-after-signed-verification");
    assert.equal(existsSync(legacy), true);
    assert.equal(existsSync(join(dataRoot, "downstream-releases", "pi-v0.81.1-patch.6", "pi-wait-for-user", "pi-core")), true);
    assert.match(migration.cleanup, /remove legacy directories manually/);

    destroy(legacy);
    activate(dataRoot, candidate);
    assert.equal(readLegacyMigration(dataRoot), null);
  } finally {
    destroy(dataRoot);
    destroy(candidate.directory);
  }
});

test("unverified legacy installation is untouched while a fresh Downstream Release is installed", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-legacy-fresh-"));
  const candidate = fixture();
  const legacy = join(dataRoot, "releases", "pi-v0.81.1-patch.6");
  const olderLegacy = join(dataRoot, "releases", "pi-v0.81.1-patch.5");
  try {
    mkdirSync(legacy, { recursive: true });
    mkdirSync(olderLegacy, { recursive: true });
    writeFileSync(join(legacy, "keep-foreign"), "untouched\n");
    writeFileSync(join(olderLegacy, "keep-older"), "older\n");
    activate(dataRoot, candidate);
    const migration = readLegacyMigration(dataRoot);
    assert.equal(migration.disposition, "fresh-install-legacy-untouched");
    assert.equal(readFileSync(join(legacy, "keep-foreign"), "utf8"), "untouched\n");
    assert.equal(readFileSync(join(olderLegacy, "keep-older"), "utf8"), "older\n");
    assert.equal(existsSync(join(dataRoot, "downstream-releases", "pi-v0.81.1-patch.6", "pi-wait-for-user", "pi-core")), true);
    assert.match(migration.cleanup, new RegExp(legacy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(migration.cleanup, new RegExp(olderLegacy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    destroy(dataRoot);
    destroy(candidate.directory);
  }
});

test("caller-selected activation roots cannot claim Command Ownership", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-unpinned-root-"));
  const bin = mkdtempSync(join(tmpdir(), "managed-runtime-unpinned-root-bin-"));
  const candidate = fixture();
  try {
    activate(dataRoot, candidate, { callerSelected: true });
    const result = runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], {
      PATH: `${bin}:/usr/bin:/bin`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /root keys pinned by the reviewed installer/);
    assert.equal(existsSync(join(bin, "pi")), false);
  } finally {
    destroy(dataRoot);
    destroy(bin);
    destroy(candidate.directory);
  }
});

test("installer claims pi only with explicit --manage-pi", () => {
  const root = mkdtempSync(join(tmpdir(), "managed-runtime-installer-"));
  const candidate = fixture();
  const trust = join(root, "trust.json");
  const channel = join(root, "channel.json");
  const manifest = join(root, "manifest.json");
  const installerRoot = join(root, "pinned-installer");
  const pinnedInstaller = join(installerRoot, "managed-installer.mjs");
  mkdirSync(join(installerRoot, "lib"), { recursive: true });
  cpSync(managedInstaller, pinnedInstaller);
  for (const library of ["managed-command.mjs", "managed-runtime.mjs", "release-metadata.mjs"]) {
    cpSync(join(repositoryRoot, "scripts", "lib", library), join(installerRoot, "lib", library));
  }
  writeFileSync(join(installerRoot, "managed-root-keys.json"), serializeMetadata({
    schemaVersion: 1,
    rootKeys: [{ keyId: "fixture-root", publicKey: rootPublic }],
  }));
  writeFileSync(trust, serializeMetadata(candidate.trustEnvelope));
  writeFileSync(channel, serializeMetadata(candidate.channelEnvelope));
  writeFileSync(manifest, serializeMetadata(candidate.manifestEnvelope));
  const common = [
    "--platform", "linux-x64",
    "--trust", trust,
    "--channel", channel,
    "--manifest", manifest,
    "--manager-archive", candidate.managerArchive,
    "--release-archive", candidate.releaseArchive,
  ];
  try {
    const sideBySideRoot = join(root, "side-by-side-data");
    const sideBySideBin = join(root, "side-by-side-bin");
    const legacy = join(sideBySideRoot, "releases", "pi-v0.81.1-patch.6");
    mkdirSync(dirname(legacy), { recursive: true });
    cpSync(join(candidate.directory, "release-payload", "pi-wait-for-user"), legacy, { recursive: true });
    const sideBySide = spawnSync(process.execPath, [pinnedInstaller,
      ...common, "--data-root", sideBySideRoot, "--bin-dir", sideBySideBin,
    ], { encoding: "utf8", env: { ...process.env, PATH: `${sideBySideBin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
    assert.equal(sideBySide.status, 0, sideBySide.stderr);
    assert.equal(existsSync(join(sideBySideBin, "pi")), false);
    assert.equal(existsSync(join(sideBySideBin, "pi-wait-for-user")), true);
    assert.match(sideBySide.stdout, /Adopted verified Legacy Downstream Installation/);
    assert.match(sideBySide.stdout, /remove legacy directories manually/);

    const managedRoot = join(root, "managed-data");
    const managedBin = join(root, "managed-bin");
    const managed = spawnSync(process.execPath, [pinnedInstaller,
      "--manage-pi", ...common, "--data-root", managedRoot, "--bin-dir", managedBin,
    ], { encoding: "utf8", env: { ...process.env, PATH: `${managedBin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
    assert.equal(managed.status, 0, managed.stderr);
    assert.equal(existsSync(join(managedBin, "pi")), true);
    assert.equal(existsSync(join(managedBin, "pi-wait-for-user")), true);
    assert.match(managed.stdout, /hash -r/);
    assert.match(managed.stdout, /command -v pi/);

    const collisionRoot = join(root, "collision-data");
    const collisionBin = join(root, "collision-bin");
    mkdirSync(collisionBin);
    writeFileSync(join(collisionBin, "pi"), "foreign\n");
    const collided = spawnSync(process.execPath, [pinnedInstaller,
      "--manage-pi", ...common, "--data-root", collisionRoot, "--bin-dir", collisionBin,
    ], { encoding: "utf8", env: { ...process.env, PATH: `${collisionBin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
    assert.notEqual(collided.status, 0);
    assert.equal(readFileSync(join(collisionBin, "pi"), "utf8"), "foreign\n");
    assert.equal(existsSync(join(collisionBin, "pi-wait-for-user")), false);
    assert.equal(existsSync(join(collisionRoot, "state", "activation.json")), false);
  } finally {
    destroy(root);
    destroy(candidate.directory);
  }
});

test("plain side-by-side setup publishes only compatibility, which can explicitly enable ownership", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-side-by-side-"));
  const bin = mkdtempSync(join(tmpdir(), "managed-runtime-side-by-side-bin-"));
  const candidate = fixture();
  const environment = {
    ...process.env,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    PI_MANAGED_PLATFORM: "linux-x64",
  };
  try {
    activate(dataRoot, candidate);
    const interrupted = runManager(dataRoot, ["managed", "install-compatibility", "--bin-dir", bin], {
      ...environment,
      PI_MANAGED_INTERRUPT_AT: "compatibility-receipt-published",
    });
    assert.notEqual(interrupted.status, 0);
    assert.equal(existsSync(join(bin, "pi-wait-for-user")), false);
    const installed = runManager(dataRoot, ["managed", "install-compatibility", "--bin-dir", bin], environment);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(existsSync(join(bin, "pi")), false);
    assert.equal(readlinkSync(join(bin, "pi-wait-for-user")), join(dataRoot, "dispatcher", "managed-dispatcher.mjs"));

    const otherBin = join(dirname(bin), "other-bin");
    const mismatchedBin = runManager(dataRoot, ["managed", "enable", "--bin-dir", otherBin], {
      PATH: `${otherBin}:${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    });
    assert.notEqual(mismatchedBin.status, 0);
    assert.match(mismatchedBin.stderr, /Compatibility Entrypoint ownership mismatch/i);
    assert.equal(existsSync(join(otherBin, "pi")), false);

    const enabled = spawnSync(join(bin, "pi-wait-for-user"), ["managed", "enable", "--bin-dir", bin], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.equal(readlinkSync(join(bin, "pi")), join(dataRoot, "dispatcher", "managed-dispatcher.mjs"));
  } finally {
    destroy(dataRoot);
    destroy(bin);
    destroy(candidate.directory);
  }
});

test("Command Ownership publication interruption never claims pi before the Compatibility Entrypoint exists", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-entrypoint-interrupt-"));
  const bin = mkdtempSync(join(tmpdir(), "managed-runtime-entrypoint-interrupt-bin-"));
  const candidate = fixture();
  const environment = { PATH: `${bin}:/usr/bin:/bin` };
  try {
    activate(dataRoot, candidate);
    const interrupted = runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], {
      ...environment,
      PI_MANAGED_INTERRUPT_AT: "compatibility-entrypoint-published",
    });
    assert.notEqual(interrupted.status, 0);
    assert.equal(existsSync(join(bin, "pi")), false);
    assert.equal(readlinkSync(join(bin, "pi-wait-for-user")), join(dataRoot, "dispatcher", "managed-dispatcher.mjs"));

    const converged = runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], environment);
    assert.equal(converged.status, 0, converged.stderr);
    assert.equal(readlinkSync(join(bin, "pi")), join(dataRoot, "dispatcher", "managed-dispatcher.mjs"));
    assert.equal(readlinkSync(join(bin, "pi-wait-for-user")), join(dataRoot, "dispatcher", "managed-dispatcher.mjs"));
  } finally {
    destroy(dataRoot);
    destroy(bin);
    destroy(candidate.directory);
  }
});

test("Command Ownership converges after Activation selects a newer Manager Release", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-manager-update-"));
  const bin = mkdtempSync(join(tmpdir(), "managed-runtime-manager-update-bin-"));
  const first = fixture();
  const next = fixture({ releaseId: "pi-v0.81.1-patch.7", managerId: "manager-v2" });
  try {
    activate(dataRoot, first);
    const environment = { PATH: `${bin}:/usr/bin:/bin` };
    assert.equal(runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], environment).status, 0);
    activate(dataRoot, next);
    const repeated = runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], environment);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /already enabled/);
  } finally {
    destroy(dataRoot);
    destroy(bin);
    destroy(first.directory);
    destroy(next.directory);
  }
});

test("managed enable records Stock Pi and publishes both command names to one Dispatcher", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-enable-"));
  const bin = mkdtempSync(join(tmpdir(), "managed-runtime-enable-bin-"));
  const stockBin = mkdtempSync(join(tmpdir(), "managed-runtime-stock-bin-"));
  const candidate = fixture();
  const stock = join(stockBin, "pi");
  try {
    writeExecutable(stock, "#!/bin/sh\necho stock-9.7\n");
    activate(dataRoot, candidate);
    const enabled = runManager(dataRoot, [
      "managed", "enable", "--bin-dir", bin,
    ], { PATH: `${bin}:${stockBin}:/usr/bin:/bin` });
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.match(enabled.stdout, /Command Ownership enabled/);
    assert.equal(readlinkSync(join(bin, "pi")), join(dataRoot, "dispatcher", "managed-dispatcher.mjs"));
    assert.equal(readlinkSync(join(bin, "pi-wait-for-user")), join(dataRoot, "dispatcher", "managed-dispatcher.mjs"));

    const ownership = readManagedOwnership(dataRoot);
    assert.equal(ownership.stock.resolvedPath, stock);
    assert.equal(ownership.stock.version, "stock-9.7");
    assert.match(ownership.stock.sha256, /^[a-f0-9]{64}$/);

    const launchEnvironment = { ...process.env, PI_MANAGED_DATA_ROOT: dataRoot, PI_MANAGED_PLATFORM: "linux-x64" };
    const compatibilityLaunch = spawnSync(join(bin, "pi-wait-for-user"), ["--help"], {
      encoding: "utf8",
      env: launchEnvironment,
    });
    const normalLaunch = spawnSync(join(bin, "pi"), ["--help"], { encoding: "utf8", env: launchEnvironment });
    assert.equal(compatibilityLaunch.status, 0, compatibilityLaunch.stderr);
    assert.equal(normalLaunch.status, 0, normalLaunch.stderr);
    assert.equal(normalLaunch.stdout, compatibilityLaunch.stdout);
    assert.match(compatibilityLaunch.stdout, /PI_ARGS: <-e> <.*question-tool> <--help>/);
  } finally {
    destroy(dataRoot);
    destroy(bin);
    destroy(stockBin);
    destroy(candidate.directory);
  }
});

test("managed enable records npm, pnpm, Bun, and mise-style Stock Pi paths without modifying them", () => {
  for (const style of ["npm", "pnpm", "bun", "mise"]) {
    const root = mkdtempSync(join(tmpdir(), `managed-runtime-stock-${style}-`));
    const dataRoot = join(root, "data");
    const bin = join(root, "managed-bin");
    const stockBin = join(root, style, "bin");
    const executable = join(root, style, "versions", "pi-core");
    const candidate = fixture();
    try {
      mkdirSync(stockBin, { recursive: true });
      mkdirSync(dirname(executable), { recursive: true });
      writeExecutable(executable, `#!/bin/sh\necho ${style}-pi-1.0\n`);
      symlinkSync(executable, join(stockBin, "pi"));
      activate(dataRoot, candidate);
      const result = runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], {
        PATH: `${bin}:${stockBin}:/usr/bin:/bin`,
      });
      assert.equal(result.status, 0, `${style}: ${result.stderr}`);
      const stock = readManagedOwnership(dataRoot).stock;
      assert.equal(stock.resolvedPath, join(stockBin, "pi"));
      assert.equal(stock.executablePath, realpathSync(executable));
      assert.equal(stock.version, `${style}-pi-1.0`);
      assert.equal(readlinkSync(join(stockBin, "pi")), executable);
    } finally {
      destroy(root);
      destroy(candidate.directory);
    }
  }
});

test("managed enable never records another Managed Dispatcher as Stock Pi", () => {
  const root = mkdtempSync(join(tmpdir(), "managed-runtime-other-dispatcher-"));
  const firstDataRoot = join(root, "first-data");
  const secondDataRoot = join(root, "second-data");
  const firstBin = join(root, "first-bin");
  const secondBin = join(root, "second-bin");
  const first = fixture();
  const second = fixture();
  try {
    activate(firstDataRoot, first);
    assert.equal(runManager(firstDataRoot, ["managed", "enable", "--bin-dir", firstBin], {
      PATH: `${firstBin}:/usr/bin:/bin`,
    }).status, 0);
    activate(secondDataRoot, second);
    const result = runManager(secondDataRoot, ["managed", "enable", "--bin-dir", secondBin], {
      PATH: `${secondBin}:${firstBin}:/usr/bin:/bin`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /another Managed Dispatcher, not Stock Pi/);
    assert.equal(existsSync(join(secondDataRoot, "state", "entrypoints.json")), false);
  } finally {
    destroy(root);
    destroy(first.directory);
    destroy(second.directory);
  }
});

test("empty PATH components resolve Stock Pi from the current directory", () => {
  const root = mkdtempSync(join(tmpdir(), "managed-runtime-current-directory-path-"));
  const dataRoot = join(root, "data");
  const bin = join(root, "bin");
  const workingDirectory = join(root, "project");
  const candidate = fixture();
  try {
    mkdirSync(workingDirectory);
    writeExecutable(join(workingDirectory, "pi"), "#!/bin/sh\necho current-directory-stock\n");
    activate(dataRoot, candidate);
    const result = runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], {
      PATH: `:${bin}:/usr/bin:/bin`,
      PWD: workingDirectory,
      PI_TEST_CWD: workingDirectory,
    });
    assert.notEqual(result.status, 0);
    assert.equal(readManagedOwnership(dataRoot).stock.resolvedPath, join(workingDirectory, "pi"));
    assert.match(result.stderr, /current command resolution selects .*project\/pi/);
  } finally {
    destroy(root);
    destroy(candidate.directory);
  }
});

test("managed enable leaves a losing-PATH installation incomplete with exact shell remediation", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-path-"));
  const binParent = mkdtempSync(join(tmpdir(), "managed-runtime-path-bin-"));
  const bin = join(binParent, "Managed Bin");
  const stockBin = mkdtempSync(join(tmpdir(), "managed-runtime-path-stock-"));
  const candidate = fixture();
  try {
    writeExecutable(join(stockBin, "pi"), "#!/bin/sh\necho stock\n");
    activate(dataRoot, candidate);
    const losing = runManager(dataRoot, [
      "managed", "enable", "--bin-dir", bin,
    ], { PATH: `${stockBin}:${bin}:/usr/bin:/bin` });
    assert.notEqual(losing.status, 0);
    assert.match(losing.stderr, new RegExp(`Put ${bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} before ${stockBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} in PATH`));
    assert.match(losing.stderr, /hash -r/);
    assert.match(losing.stderr, new RegExp(`--bin-dir '${bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
    assert.equal(readlinkSync(join(bin, "pi")), join(dataRoot, "dispatcher", "managed-dispatcher.mjs"));
    assert.equal(readlinkSync(join(bin, "pi-wait-for-user")), join(dataRoot, "dispatcher", "managed-dispatcher.mjs"));

    const absent = runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], { PATH: "/usr/bin:/bin" });
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, /current command resolution selects no pi command/);
    assert.match(absent.stderr, /export PATH='.*Managed Bin':"\$PATH"/);

    const converged = runManager(dataRoot, [
      "managed", "enable", "--bin-dir", bin,
    ], { PATH: `${bin}:${stockBin}:/usr/bin:/bin` });
    assert.equal(converged.status, 0, converged.stderr);
    assert.match(converged.stdout, /already enabled/);
  } finally {
    destroy(dataRoot);
    destroy(binParent);
    destroy(stockBin);
    destroy(candidate.directory);
  }
});

test("managed roots use platform-native data locations and ~/.local/bin by default", () => {
  assert.equal(defaultManagedDataRoot({ HOME: "/Users/example" }, "darwin"), "/Users/example/Library/Application Support/pi-wait-for-user");
  assert.equal(defaultManagedDataRoot({ HOME: "/home/example" }, "linux"), "/home/example/.local/share/pi-wait-for-user");
  assert.equal(defaultManagedDataRoot({ HOME: "/home/example", XDG_DATA_HOME: "/data" }, "linux"), "/data/pi-wait-for-user");
  assert.equal(defaultManagedBinDirectory({ HOME: "/home/example" }), "/home/example/.local/bin");
});

test("managed ownership refuses foreign command collisions without changing either target", () => {
  for (const command of ["pi", "pi-wait-for-user"]) {
    const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-collision-"));
    const bin = mkdtempSync(join(tmpdir(), "managed-runtime-collision-bin-"));
    const candidate = fixture();
    try {
      const collision = join(bin, command);
      writeFileSync(collision, "foreign\n");
      activate(dataRoot, candidate);
      const enabled = runManager(dataRoot, [
        "managed", "enable", "--bin-dir", bin,
      ], { PATH: `${bin}:/usr/bin:/bin` });
      assert.notEqual(enabled.status, 0, command);
      assert.match(enabled.stderr, /foreign command collision/);
      assert.equal(readFileSync(collision, "utf8"), "foreign\n");
      assert.equal(existsSync(join(bin, command === "pi" ? "pi-wait-for-user" : "pi")), false);
      assert.equal(existsSync(join(dataRoot, "state", "entrypoints.json")), false);
      assert.equal(existsSync(join(dataRoot, "dispatcher")), false);
    } finally {
      destroy(dataRoot);
      destroy(bin);
      destroy(candidate.directory);
    }
  }
});

test("managed ownership rejects a symlink-substituted bin-directory parent", () => {
  const root = mkdtempSync(join(tmpdir(), "managed-runtime-bin-parent-symlink-"));
  const dataRoot = join(root, "data");
  const foreign = join(root, "foreign");
  const linkedParent = join(root, "linked-parent");
  const candidate = fixture();
  try {
    mkdirSync(foreign);
    symlinkSync(foreign, linkedParent);
    activate(dataRoot, candidate);
    const result = runManager(dataRoot, ["managed", "enable", "--bin-dir", join(linkedParent, "bin")], {
      PATH: `${join(linkedParent, "bin")}:/usr/bin:/bin`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ancestor is a foreign symbolic link/);
    assert.equal(existsSync(join(foreign, "bin")), false);
    assert.equal(existsSync(join(dataRoot, "dispatcher")), false);
  } finally {
    destroy(root);
    destroy(candidate.directory);
  }
});

test("an unowned symlink to Dispatcher source is still a hard collision", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-unowned-symlink-"));
  const bin = mkdtempSync(join(tmpdir(), "managed-runtime-unowned-symlink-bin-"));
  const candidate = fixture();
  try {
    symlinkSync(dispatcher, join(bin, "pi-wait-for-user"));
    activate(dataRoot, candidate);
    const result = runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], {
      PATH: `${bin}:/usr/bin:/bin`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unowned foreign command collision/);
    assert.equal(readlinkSync(join(bin, "pi-wait-for-user")), dispatcher);
    assert.equal(existsSync(join(dataRoot, "state", "entrypoints.json")), false);
    assert.equal(existsSync(join(dataRoot, "dispatcher")), false);
  } finally {
    destroy(dataRoot);
    destroy(bin);
    destroy(candidate.directory);
  }
});

test("managed disable retains the Compatibility Entrypoint and re-enable converges", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-reenable-"));
  const bin = mkdtempSync(join(tmpdir(), "managed-runtime-reenable-bin-"));
  const candidate = fixture();
  const home = mkdtempSync(join(tmpdir(), "managed-runtime-shared-home-"));
  const shared = join(home, ".pi", "agent", "session.jsonl");
  try {
    mkdirSync(dirname(shared), { recursive: true });
    writeFileSync(shared, "shared-user-data\n");
    activate(dataRoot, candidate);
    const environment = { PATH: `${bin}:/usr/bin:/bin`, HOME: home };
    assert.equal(runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], environment).status, 0);
    assert.equal(readManagedOwnership(dataRoot).stock, null);
    const unavailableStock = runManager(dataRoot, ["managed", "stock", "--"], environment);
    assert.notEqual(unavailableStock.status, 0);
    assert.match(unavailableStock.stderr, /No Stock Pi executable was recorded/);

    rmSync(join(bin, "pi-wait-for-user"));
    writeFileSync(join(bin, "pi-wait-for-user"), "foreign\n");
    const refused = runDispatcher(dataRoot, ["managed", "disable"]);
    assert.notEqual(refused.status, 0);
    assert.equal(existsSync(join(bin, "pi")), true);
    rmSync(join(bin, "pi-wait-for-user"));
    symlinkSync(join(dataRoot, "dispatcher", "managed-dispatcher.mjs"), join(bin, "pi-wait-for-user"));

    const disabled = runDispatcher(dataRoot, ["managed", "disable"]);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(existsSync(join(bin, "pi")), false);
    assert.equal(readlinkSync(join(bin, "pi-wait-for-user")), join(dataRoot, "dispatcher", "managed-dispatcher.mjs"));
    assert.equal(runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], environment).status, 0);
    assert.equal(readlinkSync(join(bin, "pi")), join(dataRoot, "dispatcher", "managed-dispatcher.mjs"));
    assert.equal(readFileSync(shared, "utf8"), "shared-user-data\n");
  } finally {
    destroy(dataRoot);
    destroy(bin);
    destroy(home);
    destroy(candidate.directory);
  }
});

test("managed stock rechecks identity, warns about downstream sessions, and prevents recursion", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-stock-"));
  const bin = mkdtempSync(join(tmpdir(), "managed-runtime-stock-managed-bin-"));
  const stockBin = mkdtempSync(join(tmpdir(), "managed-runtime-stock-command-bin-"));
  const candidate = fixture();
  const stock = join(stockBin, "pi");
  try {
    writeExecutable(stock, "#!/bin/sh\nprintf 'STOCK_ARGS:'; printf ' <%s>' \"$@\"; printf '\\n'\n");
    activate(dataRoot, candidate);
    const environment = { PATH: `${bin}:${stockBin}:/usr/bin:/bin` };
    assert.equal(runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], environment).status, 0);
    const launched = runManager(dataRoot, ["managed", "stock", "--", "--model", "fixture"], environment);
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stderr, /Stock Pi cannot open downstream session files/);
    assert.match(launched.stdout, /STOCK_ARGS: <--model> <fixture>/);

    rmSync(stock);
    const missing = runManager(dataRoot, ["managed", "stock", "--", "--version"], environment);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Recorded Stock Pi is unavailable/);

    const changedExecuted = join(stockBin, "changed-executed");
    writeExecutable(stock, `#!/bin/sh\ntouch "${changedExecuted}"\necho changed\n`);
    const changed = runManager(dataRoot, ["managed", "stock", "--", "--version"], environment);
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /Stock Pi identity changed/);
    assert.equal(existsSync(changedExecuted), false);

    const ownershipPath = join(dataRoot, "state", "entrypoints.json");
    const ownership = JSON.parse(readFileSync(ownershipPath, "utf8"));
    ownership.stock = {
      ...ownership.stock,
      resolvedPath: join(bin, "pi"),
      executablePath: dispatcher,
      sha256: digest(readFileSync(dispatcher)),
      size: readFileSync(dispatcher).length,
      version: "recursive",
    };
    writeFileSync(ownershipPath, serializeMetadata(ownership));
    const recursive = runManager(dataRoot, ["managed", "stock", "--"], environment);
    assert.notEqual(recursive.status, 0);
    assert.match(recursive.stderr, /refusing dispatcher recursion/i);
  } finally {
    destroy(dataRoot);
    destroy(bin);
    destroy(stockBin);
    destroy(candidate.directory);
  }
});

test("stage-0 managed disable works without trusting a broken Activation and removes only its owned pi symlink", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-disable-"));
  const bin = mkdtempSync(join(tmpdir(), "managed-runtime-bin-"));
  try {
    mkdirSync(join(dataRoot, "state"), { recursive: true });
    const pi = join(bin, "pi");
    symlinkSync(dispatcher, pi);
    writeFileSync(join(dataRoot, "state", "entrypoints.json"), serializeMetadata({
      schemaVersion: 1,
      type: "managed-pi-entrypoint",
      path: pi,
      target: dispatcher,
    }));
    writeFileSync(join(dataRoot, "state", "activation.json"), "broken\n");

    const disabled = runDispatcher(dataRoot, ["managed", "disable"]);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(existsSync(pi), false);
    assert.equal(existsSync(dispatcher), true);
  } finally {
    destroy(dataRoot);
    destroy(bin);
  }
});
