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
  renameSync,
  lstatSync,
  linkSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  acceptManagedUpdateMetadata,
  acquirePairLease,
  cleanupManagedState,
  defaultManagedBinDirectory,
  defaultManagedDataRoot,
  installAndActivate,
  readActivation,
  readManagedUpdateContext,
  readLegacyInstallationAdoption,
  readManagedOwnership,
  removeInstalledPair,
  verifyManagedInstallation,
  withLifecycleLock,
} from "../scripts/lib/managed-runtime.mjs";
import {
  cachedManagedStartupNotice,
  checkManagedUpdate,
  formatManagedStatus,
  refreshManagedStartupStatus,
  performManagedUpdate,
  readManagedUpdateStatus,
  runManagedUpdate,
} from "../scripts/lib/managed-update.mjs";
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

function fixture({
  releaseId = "pi-v0.81.1-patch.6",
  managerId = "manager-v1",
  managerArchive: providedManagerArchive,
  upstreamVersion = "0.81.1",
  reportedUpstreamVersion = upstreamVersion,
  questionVersion = "0.1.3",
  payloadQuestionVersion = questionVersion,
  reportedManagerId = managerId,
  smokeExitCode = 0,
  conformanceOutput = "Deferred conformance passed (8/8)",
  readableHandlers = [{ id: "dev.taylorrowser.pi-question-tool.question", versions: [1] }],
  sequence = Number(releaseId.match(/patch\.(\d+)$/)?.[1] ?? 1),
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "managed-runtime-fixture-"));
  const managerPayload = join(directory, "manager-payload");
  const releasePayload = join(directory, "release-payload");
  mkdirSync(join(managerPayload, "package", "scripts", "lib"), { recursive: true });
  mkdirSync(join(releasePayload, "pi-wait-for-user", "question-tool", "extensions"), { recursive: true });
  cpSync(dispatcher, join(managerPayload, "package", "scripts", "managed-dispatcher.mjs"));
  cpSync(managerCli, join(managerPayload, "package", "scripts", "managed-manager.mjs"));
  cpSync(join(repositoryRoot, "scripts", "lib", "managed-command.mjs"), join(managerPayload, "package", "scripts", "lib", "managed-command.mjs"));
  cpSync(join(repositoryRoot, "scripts", "lib", "managed-runtime.mjs"), join(managerPayload, "package", "scripts", "lib", "managed-runtime.mjs"));
  cpSync(join(repositoryRoot, "scripts", "lib", "managed-update.mjs"), join(managerPayload, "package", "scripts", "lib", "managed-update.mjs"));
  cpSync(join(repositoryRoot, "scripts", "lib", "release-metadata.mjs"), join(managerPayload, "package", "scripts", "lib", "release-metadata.mjs"));

  writeExecutable(join(managerPayload, "package", "manager"), `#!/bin/sh
set -eu
directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${process.execPath}" "$directory/scripts/managed-manager.mjs" "$@"
`);
  writeFileSync(join(managerPayload, "package", "package.json"), `${JSON.stringify({
    name: "fixture-manager",
    version: "1.0.0",
    piWaitForUser: { managerReleaseId: reportedManagerId, compatibleReleaseManifestVersions: [1] },
  }, null, 2)}\n`);

  writeExecutable(join(releasePayload, "pi-wait-for-user", "pi-core"), `#!/bin/sh
case "\${1:-}" in
  --version) echo "${reportedUpstreamVersion}" ;;
  --help) echo "Pi fixture help"; exit ${smokeExitCode} ;;
  conformance) echo "${conformanceOutput}" ;;
  *)
    printf 'PI_ARGS:'; printf ' <%s>' "$@"; printf '\n'
    case " $* " in *" update --extensions "*) exit "\${PI_TEST_PACKAGE_EXIT:-0}" ;; esac
    ;;
esac
`);
  writeFileSync(join(releasePayload, "pi-wait-for-user", "question-tool", "extensions", "question-tool.ts"), "export {};\n");
  writeFileSync(join(releasePayload, "pi-wait-for-user", "question-tool", "package.json"), `${JSON.stringify({
    name: "@taylorrowser/pi-question-tool",
    version: payloadQuestionVersion,
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
      tag: `v${upstreamVersion}`,
      commit: "20be4b18d4c57487f8993d2762bace129f0cf7c6",
      packageVersion: upstreamVersion,
    },
    patches: [{ order: 1, path: "patches/active/0001.patch", sha256: digest("patch"), size: 5 }],
    compatibility: {
      questionTool: {
        name: "@taylorrowser/pi-question-tool",
        version: questionVersion,
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
        readableHandlers,
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
    sequence,
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

function markFixtureRootAsInstallerPinned(dataRoot) {
  const configPath = join(dataRoot, "state", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.rootKeyProvenance.type = "installer-pinned";
  config.rootKeyProvenance.configurationSha256 = digest(serializeMetadata({
    type: config.rootKeyProvenance.type,
    keys: config.rootKeys,
  }));
  writeFileSync(configPath, serializeMetadata(config));
}

function activate(dataRoot, candidate, options = {}) {
  const { callerSelected = false, ...activationOptions } = options;
  const result = installAndActivate({
    dataRoot,
    platform: "linux-x64",
    now,
    ...candidate,
    ...activationOptions,
  });
  if (!callerSelected) markFixtureRootAsInstallerPinned(dataRoot);
  return result;
}

function runManagedCli(executable, dataRoot, args, environment = {}) {
  const { PI_TEST_CWD, ...environmentOverrides } = environment;
  return spawnSync(process.execPath, [executable, ...args], {
    encoding: "utf8",
    cwd: PI_TEST_CWD,
    env: {
      ...process.env,
      PI_MANAGED_DATA_ROOT: dataRoot,
      PI_MANAGED_PLATFORM: "linux-x64",
      PI_SKIP_VERSION_CHECK: "1",
      ...environmentOverrides,
    },
  });
}

function runDispatcher(dataRoot, args, environment = {}) {
  return runManagedCli(dispatcher, dataRoot, args, environment);
}

function runManager(dataRoot, args, environment = {}) {
  return runManagedCli(managerCli, dataRoot, args, environment);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runDispatcherInTty(dataRoot, args, environment = {}) {
  const command = [process.execPath, dispatcher, ...args];
  const scriptArgs = process.platform === "darwin"
    ? ["-q", "-e", "/dev/null", ...command]
    : ["-qec", command.map(shellQuote).join(" "), "/dev/null"];
  return spawnSync("script", scriptArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_MANAGED_DATA_ROOT: dataRoot,
      PI_MANAGED_PLATFORM: "linux-x64",
      PI_SKIP_VERSION_CHECK: "",
      ...environment,
    },
  });
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

test("signed-payload-identical Legacy Downstream Installation is adopted only after complete verification", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-runtime-legacy-adopt-"));
  const candidate = fixture();
  const extracted = join(candidate.directory, "legacy-extracted");
  const legacy = join(candidate.directory, "custom-legacy-installation");
  try {
    mkdirSync(extracted);
    assert.equal(spawnSync("tar", ["-xzf", candidate.releaseArchive, "-C", extracted]).status, 0);
    cpSync(join(extracted, "pi-wait-for-user"), legacy, { recursive: true });

    activate(dataRoot, candidate, { legacyDirectories: [legacy] });
    const adoption = readLegacyInstallationAdoption(dataRoot);
    assert.equal(adoption.disposition, "adopted-after-signed-verification");
    assert.equal(existsSync(legacy), true);
    assert.equal(existsSync(join(dataRoot, "downstream-releases", "pi-v0.81.1-patch.6", "pi-wait-for-user", "pi-core")), true);
    assert.match(adoption.cleanup, /remove Legacy Downstream Installation directories manually/);

    destroy(legacy);
    activate(dataRoot, candidate);
    assert.equal(readLegacyInstallationAdoption(dataRoot), null);
  } finally {
    destroy(dataRoot);
    destroy(candidate.directory);
  }
});

test("unverified Legacy Downstream Installation is untouched while a fresh Downstream Release is installed", () => {
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
    const adoption = readLegacyInstallationAdoption(dataRoot);
    assert.equal(adoption.disposition, "fresh-install-legacy-untouched");
    assert.equal(readFileSync(join(legacy, "keep-foreign"), "utf8"), "untouched\n");
    assert.equal(readFileSync(join(olderLegacy, "keep-older"), "utf8"), "older\n");
    assert.equal(existsSync(join(dataRoot, "downstream-releases", "pi-v0.81.1-patch.6", "pi-wait-for-user", "pi-core")), true);
    assert.match(adoption.cleanup, new RegExp(legacy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(adoption.cleanup, new RegExp(olderLegacy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
  const nextCandidate = fixture({ releaseId: "pi-v0.81.1-patch.7", managerId: "manager-v2" });
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
    assert.match(sideBySide.stdout, /remove Legacy Downstream Installation directories manually/);
    const repeatedSideBySide = spawnSync(process.execPath, [pinnedInstaller,
      ...common, "--data-root", sideBySideRoot, "--bin-dir", sideBySideBin,
    ], { encoding: "utf8", env: { ...process.env, PATH: `${sideBySideBin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
    assert.equal(repeatedSideBySide.status, 0, repeatedSideBySide.stderr);

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

    writeFileSync(trust, serializeMetadata(nextCandidate.trustEnvelope));
    writeFileSync(channel, serializeMetadata(nextCandidate.channelEnvelope));
    writeFileSync(manifest, serializeMetadata(nextCandidate.manifestEnvelope));
    const failedAfterActivation = spawnSync(process.execPath, [pinnedInstaller,
      "--manage-pi",
      "--platform", "linux-x64",
      "--trust", trust,
      "--channel", channel,
      "--manifest", manifest,
      "--manager-archive", nextCandidate.managerArchive,
      "--release-archive", nextCandidate.releaseArchive,
      "--data-root", managedRoot,
      "--bin-dir", managedBin,
    ], { encoding: "utf8", env: { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` } });
    assert.notEqual(failedAfterActivation.status, 0);
    assert.equal(readActivation(managedRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.6");

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
    destroy(nextCandidate.directory);
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

    const piPublished = runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], {
      ...environment,
      PI_MANAGED_INTERRUPT_AT: "pi-entrypoint-published",
    });
    assert.notEqual(piPublished.status, 0);
    assert.equal(readlinkSync(join(bin, "pi")), join(dataRoot, "dispatcher", "managed-dispatcher.mjs"));
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
  const binAliasRoot = mkdtempSync(join(tmpdir(), "managed-runtime-enable-bin-alias-"));
  const binAlias = join(binAliasRoot, "bin");
  const foreignBin = mkdtempSync(join(tmpdir(), "managed-runtime-enable-foreign-bin-"));
  const stockBin = mkdtempSync(join(tmpdir(), "managed-runtime-stock-bin-"));
  const candidate = fixture();
  const stock = join(stockBin, "pi");
  try {
    writeExecutable(stock, "#!/bin/sh\necho stock-9.7\n");
    symlinkSync(bin, binAlias);
    activate(dataRoot, candidate);
    const enabled = runManager(dataRoot, [
      "managed", "enable", "--bin-dir", bin,
    ], { PATH: `${binAlias}:${stockBin}:/usr/bin:/bin` });
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

    symlinkSync(join(dataRoot, "dispatcher", "managed-dispatcher.mjs"), join(foreignBin, "pi"));
    const foreignResolution = runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], {
      PATH: `${foreignBin}:${bin}:/usr/bin:/bin`,
    });
    assert.notEqual(foreignResolution.status, 0);
    assert.match(foreignResolution.stderr, new RegExp(`current command resolution selects ${foreignBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pi`));
  } finally {
    destroy(dataRoot);
    destroy(bin);
    destroy(binAliasRoot);
    destroy(foreignBin);
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
    mkdirSync(join(root, "spoofed-pwd"));
    writeExecutable(join(workingDirectory, "pi"), "#!/bin/sh\necho current-directory-stock\n");
    activate(dataRoot, candidate);
    const result = runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], {
      PATH: `:${bin}:/usr/bin:/bin`,
      PWD: join(root, "spoofed-pwd"),
      PI_TEST_CWD: workingDirectory,
    });
    assert.notEqual(result.status, 0);
    assert.equal(readManagedOwnership(dataRoot).stock.resolvedPath, join(realpathSync(workingDirectory), "pi"));
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

test("Command Ownership refuses foreign command collisions without changing either target", () => {
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

test("Command Ownership rejects a symlink-substituted bin-directory parent", () => {
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
  const stockBin = mkdtempSync(join(tmpdir(), "managed-runtime-reenable-stock-bin-"));
  const candidate = fixture();
  const home = mkdtempSync(join(tmpdir(), "managed-runtime-shared-home-"));
  const shared = join(home, ".pi", "agent", "session.jsonl");
  try {
    mkdirSync(dirname(shared), { recursive: true });
    writeFileSync(shared, "shared-user-data\n");
    activate(dataRoot, candidate);
    const environment = { PATH: `${bin}:${stockBin}:/usr/bin:/bin`, HOME: home };
    assert.equal(runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], environment).status, 0);
    assert.equal(readManagedOwnership(dataRoot).stock, null);
    const unavailableStock = runManager(dataRoot, ["managed", "stock", "--"], environment);
    assert.notEqual(unavailableStock.status, 0);
    assert.match(unavailableStock.stderr, /No Stock Pi executable was recorded/);

    const movedBin = `${bin}-owned`;
    const foreignBin = `${bin}-foreign`;
    renameSync(bin, movedBin);
    mkdirSync(foreignBin);
    symlinkSync(foreignBin, bin);
    const substitutedEnable = runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], environment);
    assert.notEqual(substitutedEnable.status, 0);
    const substitutedDisable = runDispatcher(dataRoot, ["managed", "disable"]);
    assert.notEqual(substitutedDisable.status, 0);
    assert.deepEqual(readdirSync(foreignBin), []);
    rmSync(bin);
    renameSync(movedBin, bin);
    destroy(foreignBin);

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
    const repeatedDisable = runDispatcher(dataRoot, ["managed", "disable"]);
    assert.equal(repeatedDisable.status, 0, repeatedDisable.stderr);
    assert.match(repeatedDisable.stdout, /already disabled/);
    writeExecutable(join(stockBin, "pi"), "#!/bin/sh\necho newly-installed-stock\n");
    assert.equal(runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], environment).status, 0);
    assert.equal(readlinkSync(join(bin, "pi")), join(dataRoot, "dispatcher", "managed-dispatcher.mjs"));
    assert.equal(readManagedOwnership(dataRoot).stock.version, "newly-installed-stock");
    assert.equal(readFileSync(shared, "utf8"), "shared-user-data\n");
  } finally {
    destroy(dataRoot);
    destroy(bin);
    destroy(stockBin);
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
  const stockExecutable = join(stockBin, "stock-pi-executable");
  try {
    writeExecutable(stockExecutable, "#!/bin/sh\nprintf 'STOCK_COMMAND:%s\\n' \"$0\"; printf 'STOCK_ARGS:'; printf ' <%s>' \"$@\"; printf '\\n'\n");
    symlinkSync(stockExecutable, stock);
    activate(dataRoot, candidate);
    const environment = { PATH: `${bin}:${stockBin}:/usr/bin:/bin` };
    assert.equal(runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], environment).status, 0);
    const launched = runManager(dataRoot, ["managed", "stock", "--", "--model", "fixture"], environment);
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stderr, /Stock Pi cannot open downstream session files/);
    assert.match(launched.stdout, new RegExp(`STOCK_COMMAND:${stock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
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

function managedNetworkEnvironment(candidate, directory, upstreamVersion = candidate.manifestEnvelope.signed.upstream.packageVersion) {
  const files = {
    trust: join(directory, "network-trust.json"),
    channel: join(directory, "network-channel.json"),
    manifest: join(directory, "network-manifest.json"),
    upstream: join(directory, "network-upstream.json"),
  };
  writeFileSync(files.trust, serializeMetadata(candidate.trustEnvelope));
  writeFileSync(files.channel, serializeMetadata(candidate.channelEnvelope));
  writeFileSync(files.manifest, serializeMetadata(candidate.manifestEnvelope));
  writeFileSync(files.upstream, serializeMetadata({ version: upstreamVersion }));
  const manifestUrl = candidate.channelEnvelope.signed.manifest.url;
  const mapping = {
    "https://example.test/release-trust.json": files.trust,
    [candidate.trustEnvelope.signed.channelUrl]: files.channel,
    [manifestUrl]: files.manifest,
    "https://pi.dev/api/latest-version": files.upstream,
    [new URL(basename(candidate.managerArchive), manifestUrl).href]: candidate.managerArchive,
    [new URL(basename(candidate.releaseArchive), manifestUrl).href]: candidate.releaseArchive,
  };
  const hook = join(directory, "managed-fetch-hook.mjs");
  writeFileSync(hook, `
import { readFileSync } from "node:fs";
const mapping = JSON.parse(process.env.PI_MANAGED_NETWORK_MAP);
globalThis.fetch = async (input) => {
  const url = String(input);
  const path = mapping[url];
  if (!path) return new Response("not found", { status: 404 });
  const body = readFileSync(path);
  const headers = process.env.PI_TEST_OMIT_CONTENT_LENGTH ? undefined : { "content-length": String(body.length) };
  return new Response(body, { status: 200, headers });
};
`);
  return {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${hook}`.trim(),
    PI_MANAGED_NETWORK_MAP: JSON.stringify(mapping),
  };
}

function updateTransport(candidate, { upstreamVersion = candidate.manifestEnvelope.signed.upstream.packageVersion, fail = new Map() } = {}) {
  const manifestUrl = candidate.channelEnvelope.signed.manifest.url;
  const documents = new Map([
    ["https://example.test/release-trust.json", candidate.trustEnvelope],
    [candidate.trustEnvelope.signed.channelUrl, candidate.channelEnvelope],
    [manifestUrl, candidate.manifestEnvelope],
    ["https://pi.dev/api/latest-version", { version: upstreamVersion }],
  ]);
  const artifacts = new Map([
    [new URL(basename(candidate.managerArchive), manifestUrl).href, readFileSync(candidate.managerArchive)],
    [new URL(basename(candidate.releaseArchive), manifestUrl).href, readFileSync(candidate.releaseArchive)],
  ]);
  const requested = [];
  return {
    requested,
    async json(url, label) {
      requested.push({ type: "json", url, label });
      if (fail.has(url)) throw new Error(fail.get(url));
      if (!documents.has(url)) throw new Error(`Unexpected metadata URL: ${url}`);
      return structuredClone(documents.get(url));
    },
    async artifact(url, destination, label) {
      requested.push({ type: "artifact", url, label });
      if (fail.has(url)) throw new Error(fail.get(url));
      if (!artifacts.has(url)) throw new Error(`Unexpected artifact URL: ${url}`);
      writeFileSync(destination, artifacts.get(url));
    },
  };
}

test("signed Channel sequence and Downstream Release identity detect every compatible pair change", async () => {
  const variants = [
    fixture({ releaseId: "pi-v0.81.1-patch.7" }),
    fixture({ releaseId: "pi-v0.81.1-patch.8", managerId: "manager-v2" }),
    fixture({ releaseId: "pi-v0.81.1-patch.9", questionVersion: "0.1.4" }),
    fixture({ releaseId: "pi-v0.82.0-patch.1", upstreamVersion: "0.82.0", sequence: 10 }),
  ];
  for (const candidate of variants) {
    const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-selection-"));
    const current = fixture();
    try {
      activate(dataRoot, current);
      const result = await checkManagedUpdate(dataRoot, { transport: updateTransport(candidate), now });
      assert.equal(result.kind, "compatible-update");
      assert.equal(result.candidate.releaseId, candidate.manifestEnvelope.signed.releaseId);
      assert.equal(result.channel.sequence, candidate.channelEnvelope.signed.sequence);
      assert.equal(result.candidate.upstreamVersion, candidate.manifestEnvelope.signed.upstream.packageVersion);
    } finally {
      destroy(dataRoot);
      destroy(current.directory);
      destroy(candidate.directory);
    }
  }
});

test("Managed Update downloads only signed-manifest artifacts and atomically activates the verified pair", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-activation-"));
  const current = fixture();
  const candidate = fixture({ releaseId: "pi-v0.81.1-patch.7", managerArchive: current.managerArchive });
  try {
    activate(dataRoot, current);
    writeFileSync(join(dataRoot, "state", "update-hold.json"), serializeMetadata({
      schemaVersion: 1,
      type: "update-hold",
      releaseId: "pi-v0.81.1-patch.7",
      createdAt: now.toISOString(),
    }));
    const transport = updateTransport(candidate, { upstreamVersion: "99.0.0" });
    const result = await performManagedUpdate(dataRoot, { transport, now });
    assert.equal(result.kind, "activated");
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.7");
    assert.equal(existsSync(join(dataRoot, "state", "update-hold.json")), false);
    assert.deepEqual(transport.requested.filter((entry) => entry.type === "artifact").map((entry) => entry.url).sort(), [
      new URL(basename(candidate.managerArchive), candidate.channelEnvelope.signed.manifest.url).href,
      new URL(basename(candidate.releaseArchive), candidate.channelEnvelope.signed.manifest.url).href,
    ].sort());
    assert.equal(transport.requested.some((entry) => entry.url.includes("99.0.0")), false);
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
    destroy(candidate.directory);
  }
});

test("Managed Update rejects a changed manifest that reuses an immutable Downstream Release identity", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-reused-release-id-"));
  const current = fixture();
  try {
    activate(dataRoot, current);
    const manifestEnvelope = signMetadata({
      ...current.manifestEnvelope.signed,
      publishedAt: "2026-07-24T11:00:00.000Z",
    }, "fixture-release", releasePrivate);
    const channelEnvelope = signMetadata({
      ...current.channelEnvelope.signed,
      sequence: current.channelEnvelope.signed.sequence + 1,
      manifest: {
        ...current.channelEnvelope.signed.manifest,
        sha256: digest(serializeMetadata(manifestEnvelope)),
      },
    }, "fixture-release", releasePrivate);
    const candidate = { ...current, manifestEnvelope, channelEnvelope };

    await assert.rejects(
      performManagedUpdate(dataRoot, { transport: updateTransport(candidate), now }),
      /Immutable downstream release identity already exists with different content/,
    );
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.6");
    const launched = runDispatcher(dataRoot, ["--help"], { PI_OFFLINE: "1" });
    assert.equal(launched.status, 0, launched.stderr);
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
  }
});

test("Managed Update accepts streamed signed-size artifacts without Content-Length", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-chunked-download-"));
  const current = fixture();
  const candidate = fixture({ releaseId: "pi-v0.81.1-patch.7", managerArchive: current.managerArchive });
  try {
    activate(dataRoot, current);
    const result = runDispatcher(dataRoot, ["update"], {
      ...managedNetworkEnvironment(candidate, candidate.directory),
      PI_TEST_OMIT_CONTENT_LENGTH: "1",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Activated Downstream Release pi-v0\.81\.1-patch\.7/);
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.7");
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
    destroy(candidate.directory);
  }
});

test("Patch Lag is a successful no-op and upstream outage cannot invalidate a checked Channel", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-patch-lag-"));
  const current = fixture();
  try {
    activate(dataRoot, current);
    const lag = await performManagedUpdate(dataRoot, { transport: updateTransport(current, { upstreamVersion: "0.82.0" }), now });
    assert.deepEqual(lag.patchLag, {
      currentReleaseId: "pi-v0.81.1-patch.6",
      currentUpstreamVersion: "0.81.1",
      observedUpstreamVersion: "0.82.0",
    });
    assert.equal(lag.kind, "patch-lag");
    assert.match(cachedManagedStartupNotice(dataRoot, { interactive: true }), /Patch Lag.*0\.81\.1.*0\.82\.0/);
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.6");

    const upstreamFailure = updateTransport(current, {
      fail: new Map([["https://pi.dev/api/latest-version", "upstream unavailable"]]),
    });
    const checked = await checkManagedUpdate(dataRoot, { transport: upstreamFailure, now });
    assert.equal(checked.kind, "current");
    assert.match(checked.upstreamError, /upstream unavailable/);

    const channelFailure = updateTransport(current, {
      fail: new Map([[current.trustEnvelope.signed.channelUrl, "channel unavailable"]]),
    });
    await assert.rejects(
      performManagedUpdate(dataRoot, { transport: channelFailure, now }),
      /Managed Update failed during Channel discovery: channel unavailable/,
    );
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
  }
});

test("Managed Update rejects replay and unknown schemas while retaining the current Activation", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-metadata-failure-"));
  const current = fixture();
  try {
    activate(dataRoot, current);
    const replay = fixture({ releaseId: "pi-v0.81.1-patch.5", sequence: 5 });
    await assert.rejects(performManagedUpdate(dataRoot, { transport: updateTransport(replay), now }), /sequence replay/i);
    destroy(replay.directory);

    for (const [metadata, expected] of [
      ["trustEnvelope", /unknown release-trust schema version 99/i],
      ["channelEnvelope", /unknown release-channel schema version 99/i],
      ["manifestEnvelope", /unknown release-manifest schema version 99/i],
    ]) {
      const unknown = fixture({ releaseId: "pi-v0.81.1-patch.7" });
      unknown[metadata].signed.schemaVersion = 99;
      await assert.rejects(performManagedUpdate(dataRoot, { transport: updateTransport(unknown), now }), expected);
      destroy(unknown.directory);
    }
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.6");
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
  }
});

test("--all keeps a verified activation when the newly active Pi package phase fails", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-all-"));
  const current = fixture();
  const candidate = fixture({ releaseId: "pi-v0.81.1-patch.7", managerArchive: current.managerArchive });
  try {
    activate(dataRoot, current);
    let packagePair;
    const phases = [];
    const result = await runManagedUpdate(dataRoot, {
      all: true,
      transport: updateTransport(candidate),
      now,
      managedPhaseComplete() { phases.push("managed"); },
      packagePhase(selected) {
        phases.push("packages");
        packagePair = selected.pair;
        return 23;
      },
    });
    assert.deepEqual(phases, ["managed", "packages"]);
    assert.equal(result.partial, true);
    assert.equal(result.exitCode, 23);
    assert.equal(packagePair.downstreamReleaseId, "pi-v0.81.1-patch.7");
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.7");
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
    destroy(candidate.directory);
  }
});

test("cached startup status is throttled, isolated to interactive output, and respects check controls", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-startup-"));
  const current = fixture();
  const candidate = fixture({ releaseId: "pi-v0.81.1-patch.7" });
  try {
    activate(dataRoot, current);
    await checkManagedUpdate(dataRoot, { transport: updateTransport(candidate), now, cache: true });
    const cached = readManagedUpdateStatus(dataRoot);
    assert.equal(cached.compatibleUpdate.releaseId, "pi-v0.81.1-patch.7");
    for (const malformed of [
      { ...cached, compatibleUpdate: { ...cached.compatibleUpdate, sequence: cached.channel.sequence + 1 } },
      { ...cached, patchLag: {
        currentReleaseId: cached.active.releaseId,
        currentUpstreamVersion: cached.active.upstreamVersion,
        observedUpstreamVersion: "0.82.0",
      } },
    ]) {
      writeFileSync(join(dataRoot, "state", "update-status.json"), serializeMetadata(malformed));
      assert.throws(() => readManagedUpdateStatus(dataRoot), /Malformed managed update status/);
    }
    writeFileSync(join(dataRoot, "state", "update-status.json"), serializeMetadata(cached));
    assert.match(cachedManagedStartupNotice(dataRoot, { interactive: true }), /compatible Downstream Release.*patch\.7/i);
    const updateHold = {
      schemaVersion: 1,
      type: "update-hold",
      releaseId: "pi-v0.81.1-patch.7",
      createdAt: now.toISOString(),
    };
    writeFileSync(join(dataRoot, "state", "update-hold.json"), serializeMetadata(updateHold));
    assert.equal(cachedManagedStartupNotice(dataRoot, { interactive: true }), null);
    for (const malformed of [{ ...updateHold, foreign: true }, { ...updateHold, createdAt: "not-a-date" }]) {
      writeFileSync(join(dataRoot, "state", "update-hold.json"), serializeMetadata(malformed));
      assert.throws(
        () => cachedManagedStartupNotice(dataRoot, { interactive: true }),
        /Malformed Update Hold/,
      );
    }
    writeFileSync(join(dataRoot, "state", "update-hold.json"), serializeMetadata(updateHold));
    assert.equal(cachedManagedStartupNotice(dataRoot, { interactive: false }), null);
    assert.equal(cachedManagedStartupNotice(dataRoot, { interactive: true, environment: { PI_SKIP_VERSION_CHECK: "1" } }), null);
    assert.equal(cachedManagedStartupNotice(dataRoot, { interactive: true, environment: { PI_OFFLINE: "1" } }), null);

    rmSync(join(dataRoot, "state", "startup-check.json"), { force: true });
    const startupTransport = updateTransport(candidate);
    await refreshManagedStartupStatus(dataRoot, { transport: startupTransport, now, environment: { PI_SKIP_VERSION_CHECK: "1" } });
    await refreshManagedStartupStatus(dataRoot, { transport: startupTransport, now, environment: { PI_OFFLINE: "1" } });
    assert.equal(startupTransport.requested.length, 0);
    assert.equal(existsSync(join(dataRoot, "state", "startup-check.json")), false);

    writeFileSync(join(dataRoot, "state", "startup-check.lock"), "interrupted\n");
    await refreshManagedStartupStatus(dataRoot, { transport: startupTransport, now });
    const requestCount = startupTransport.requested.length;
    assert.ok(requestCount > 0);
    await refreshManagedStartupStatus(dataRoot, { transport: startupTransport, now: new Date(now.getTime() + 60_000) });
    assert.equal(startupTransport.requested.length, requestCount);
    await refreshManagedStartupStatus(dataRoot, { transport: startupTransport, now: new Date(now.getTime() + 86_400_001) });
    assert.equal(startupTransport.requested.length, requestCount * 2);
    for (const malformed of [
      { schemaVersion: 1, type: "managed-startup-check", lastAttemptAt: "not-a-date" },
      { schemaVersion: 1, type: "managed-startup-check", lastAttemptAt: now.toISOString(), foreign: true },
    ]) {
      writeFileSync(join(dataRoot, "state", "startup-check.json"), serializeMetadata(malformed));
      await assert.rejects(
        refreshManagedStartupStatus(dataRoot, { transport: startupTransport, now: new Date(now.getTime() + 2 * 86_400_000) }),
        /Malformed startup check state/,
      );
      assert.deepEqual(JSON.parse(readFileSync(join(dataRoot, "state", "startup-check.json"), "utf8")), malformed);
    }

    const later = fixture({ releaseId: "pi-v0.81.1-patch.8" });
    try {
      acceptManagedUpdateMetadata(dataRoot, later, { now });
      assert.equal(cachedManagedStartupNotice(dataRoot, { interactive: true }), null);
    } finally {
      destroy(later.directory);
    }
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
    destroy(candidate.directory);
  }
});

test("detached startup refresh resumes after interruption immediately after its durable throttle claim", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-startup-recovery-"));
  const current = fixture();
  try {
    activate(dataRoot, current);
    writeFileSync(join(dataRoot, "state", "startup-check.lock"), "interrupted\n");
    const transport = updateTransport(current);
    await assert.rejects(
      refreshManagedStartupStatus(dataRoot, {
        transport,
        now,
        checkpoint(name) {
          if (name === "startup-check-recovery-claimed") throw new Error(`Interrupted at ${name}`);
        },
      }),
      /Interrupted at startup-check-recovery-claimed/,
    );
    assert.equal(transport.requested.length, 0);
    await refreshManagedStartupStatus(dataRoot, { transport, now });
    assert.ok(transport.requested.length > 0);
    assert.equal(existsSync(join(dataRoot, "state", "startup-check.lock")), false);
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
  }
});

test("managed status reports pair compatibility, Stock Pi, Channel, Patch Lag, and Update Hold", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-status-"));
  const current = fixture({
    readableHandlers: [
      { id: "dev.taylorrowser.pi-question-tool.question", versions: [1] },
      { id: "dev.taylorrowser.pi-question-tool.legacy", versions: [1, 2] },
    ],
  });
  try {
    activate(dataRoot, current);
    await checkManagedUpdate(dataRoot, { transport: updateTransport(current, { upstreamVersion: "0.82.0" }), now, cache: true });
    writeFileSync(join(dataRoot, "state", "update-hold.json"), serializeMetadata({
      schemaVersion: 1,
      type: "update-hold",
      releaseId: "pi-v0.81.1-patch.7",
      createdAt: now.toISOString(),
    }));
    const context = readManagedUpdateContext(dataRoot);
    assert.equal(context.active.releaseId, "pi-v0.81.1-patch.6");
    const status = formatManagedStatus(dataRoot);
    for (const expected of [
      "pi-v0.81.1-patch.6", "manager-v1", "0.81.1", "linux-x64",
      "dev.taylorrowser.pi-wait-for-user/session@1", "protocol versions: 1",
      "dev.taylorrowser.pi-question-tool.question@1", "dev.taylorrowser.pi-question-tool.legacy@1,2", "Channel sequence: 6",
      "Patch Lag: upstream Pi 0.82.0", "Update Hold: pi-v0.81.1-patch.7", "Stock Pi: not recorded",
    ]) assert.match(status, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
  }
});

test("Managed Dispatcher never exposes self-inclusive Stock Pi updates while preserving package update commands", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-dispatch-"));
  const current = fixture();
  try {
    activate(dataRoot, current);
    for (const args of [
      ["update", "--extensions"], ["update", "--extensions", "--force"],
      ["update", "--models"], ["update", "npm:@foo/bar"],
      ["update", "--extension", "npm:@foo/bar"],
    ]) {
      const packages = runDispatcher(dataRoot, args, { PI_OFFLINE: "1" });
      assert.equal(packages.status, 0, packages.stderr);
      assert.match(packages.stdout, /^PI_ARGS: <update>/m);
      assert.doesNotMatch(packages.stdout, /PI_ARGS: <-e>/);
    }

    for (const args of [
      ["update"], ["update", "pi"], ["update", "self"], ["update", "--self"],
      ["update", "--force"], ["update", "--self", "--force"],
      ["update", "--all"], ["update", "--self", "--extensions"], ["update", "pi", "--extensions"],
    ]) {
      const result = runDispatcher(dataRoot, args, { PI_OFFLINE: "1" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Managed Update is unavailable while PI_OFFLINE is set/);
      assert.doesNotMatch(result.stdout, /PI_ARGS:/);
    }
    for (const args of [["update", "--self", "--models"], ["update", "--mystery"]]) {
      const result = runDispatcher(dataRoot, args, { PI_OFFLINE: "1" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unknown update syntax/);
      assert.doesNotMatch(result.stdout, /PI_ARGS:/);
    }

    const status = runDispatcher(dataRoot, ["managed", "status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Active Downstream Release: pi-v0\.81\.1-patch\.6/);
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
  }
});

test("candidate verification failure removes temporary payloads, bounds diagnostics, and retains Activation", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-verification-failure-"));
  const current = fixture();
  const candidate = fixture({ releaseId: "pi-v0.81.1-patch.7", managerArchive: current.managerArchive });
  try {
    activate(dataRoot, current);
    const diagnostics = join(dataRoot, "diagnostics");
    for (let index = 0; index < 12; index += 1) writeFileSync(join(diagnostics, `000-${String(index).padStart(2, "0")}.json`), "{}\n");
    const transport = updateTransport(candidate);
    const artifact = transport.artifact.bind(transport);
    const destinations = [];
    transport.artifact = async (url, destination, label) => {
      destinations.push(destination);
      await artifact(url, destination, label);
      if (label === "Downstream Release") writeFileSync(destination, "untrusted executable payload");
    };
    await assert.rejects(performManagedUpdate(dataRoot, { transport, now }), /Downstream Release artifact size mismatch/);
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.6");
    assert.ok(destinations.every((destination) => destination.startsWith(join(dataRoot, "tmp", "update.tmp-"))));
    assert.equal(readdirSync(join(dataRoot, "tmp")).some((name) => name.startsWith("update.tmp-")), false);
    let retained = readdirSync(diagnostics).filter((name) => name.endsWith(".json"));
    const managedDiagnosticPattern = /^\d+-[0-9a-f-]{36}\.json$/;
    assert.ok(retained.filter((name) => managedDiagnosticPattern.test(name)).length <= 10);
    for (let index = 0; index < 12; index += 1) {
      assert.equal(readFileSync(join(diagnostics, `000-${String(index).padStart(2, "0")}.json`), "utf8"), "{}\n");
    }
    const diagnosticValues = retained.map((name) => JSON.parse(readFileSync(join(diagnostics, name), "utf8")));
    assert.ok(diagnosticValues.some(
      (value) => value.type === "activation-failure" && value.stage === "verification-and-activation",
    ), JSON.stringify(diagnosticValues));
    await assert.rejects(
      performManagedUpdate(dataRoot, { transport: updateTransport(current), now }),
      /Channel sequence replay/,
    );
    retained = readdirSync(diagnostics).filter((name) => name.endsWith(".json"));
    assert.ok(retained.filter((name) => managedDiagnosticPattern.test(name)).length <= 10);
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
    destroy(candidate.directory);
  }
});

test("Managed Update fails closed at reported identity, smoke, and conformance boundaries", () => {
  const cases = [
    [{ managerId: "manager-v2", reportedManagerId: "manager-v-wrong" }, /Manager Release compatibility mismatch/],
    [{ reportedUpstreamVersion: "0.80.0" }, /Pi reported version mismatch/],
    [{ payloadQuestionVersion: "0.0.0" }, /Question Tool package identity mismatch/],
    [{ smokeExitCode: 7 }, /Pi smoke check failed/],
    [{ conformanceOutput: "Deferred conformance failed" }, /Pi conformance did not report success/],
  ];
  for (const [fixtureOptions, expected] of cases) {
    const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-verification-boundary-"));
    const current = fixture();
    const candidate = fixture({ releaseId: "pi-v0.81.1-patch.7", ...fixtureOptions });
    try {
      activate(dataRoot, current);
      const result = runDispatcher(dataRoot, ["update"], managedNetworkEnvironment(candidate, candidate.directory));
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, expected);
      assert.doesNotMatch(result.stdout, /PI_ARGS:/);
      assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.6");
      assert.equal(readdirSync(join(dataRoot, "tmp")).some((name) => name.startsWith("update.tmp-")), false);
      const diagnostics = readdirSync(join(dataRoot, "diagnostics"))
        .map((name) => JSON.parse(readFileSync(join(dataRoot, "diagnostics", name), "utf8")));
      assert.ok(diagnostics.some((entry) => entry.type === "activation-failure"), JSON.stringify(diagnostics));
    } finally {
      destroy(dataRoot);
      destroy(current.directory);
      destroy(candidate.directory);
    }
  }
});

test("startup never advertises a signed Channel candidate incompatible with the active platform", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-incompatible-"));
  const current = fixture();
  const candidate = fixture({ releaseId: "pi-v0.81.1-patch.7" });
  try {
    activate(dataRoot, current);
    const manifest = structuredClone(candidate.manifestEnvelope.signed);
    manifest.platformArchives[0].platform = "linux-arm64";
    candidate.manifestEnvelope = signMetadata(manifest, "fixture-release", releasePrivate);
    candidate.channelEnvelope = signMetadata({
      ...candidate.channelEnvelope.signed,
      manifest: {
        ...candidate.channelEnvelope.signed.manifest,
        sha256: digest(serializeMetadata(candidate.manifestEnvelope)),
      },
    }, "fixture-release", releasePrivate);
    const checked = await checkManagedUpdate(dataRoot, { transport: updateTransport(candidate), now });
    assert.equal(checked.kind, "incompatible");
    assert.equal(readManagedUpdateStatus(dataRoot).compatibleUpdate, null);
    assert.equal(cachedManagedStartupNotice(dataRoot, { interactive: true }), null);
    await assert.rejects(
      performManagedUpdate(dataRoot, { transport: updateTransport(candidate), now }),
      /candidate compatibility: platform is not declared: linux-x64/,
    );
    const patchLag = await performManagedUpdate(dataRoot, {
      transport: updateTransport(candidate, { upstreamVersion: "0.82.0" }),
      now,
    });
    assert.equal(patchLag.kind, "patch-lag");
    assert.deepEqual(patchLag.patchLag, {
      currentReleaseId: "pi-v0.81.1-patch.6",
      currentUpstreamVersion: "0.81.1",
      observedUpstreamVersion: "0.82.0",
    });
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.6");
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
    destroy(candidate.directory);
  }
});

test("managed status reports recorded Stock Pi identity divergence", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-stock-status-"));
  const bin = mkdtempSync(join(tmpdir(), "managed-update-stock-status-bin-"));
  const stockBin = mkdtempSync(join(tmpdir(), "managed-update-stock-status-command-"));
  const current = fixture();
  try {
    activate(dataRoot, current);
    const stock = join(stockBin, "pi");
    writeExecutable(stock, "#!/bin/sh\nif [ \"${1:-}\" = --version ]; then echo stock-2.4; fi\n");
    const environment = { PATH: `${bin}:${stockBin}:${dirname(process.execPath)}:/usr/bin:/bin` };
    assert.equal(runManager(dataRoot, ["managed", "enable", "--bin-dir", bin], environment).status, 0);
    assert.match(formatManagedStatus(dataRoot), new RegExp(`Stock Pi: stock-2.4 at ${stock.replaceAll("/", "\\/")}`));
    writeExecutable(stock, "#!/bin/sh\necho changed\n");
    assert.match(formatManagedStatus(dataRoot), /Stock Pi: stock-2.4.*divergence: Stock Pi identity changed/s);
  } finally {
    destroy(dataRoot);
    destroy(bin);
    destroy(stockBin);
    destroy(current.directory);
  }
});

test("explicit CLI renders current, Patch Lag, ordered --all success, and nonzero partial output", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-cli-all-"));
  const current = fixture();
  const candidate = fixture({ releaseId: "pi-v0.81.1-patch.7", managerArchive: current.managerArchive });
  const later = fixture({ releaseId: "pi-v0.81.1-patch.8", managerArchive: current.managerArchive });
  try {
    activate(dataRoot, current);
    const currentEnvironment = managedNetworkEnvironment(current, current.directory);
    const currentResult = runDispatcher(dataRoot, ["update"], currentEnvironment);
    assert.equal(currentResult.status, 0, currentResult.stderr);
    assert.match(currentResult.stdout, /Already current: pi-v0\.81\.1-patch\.6/);

    const lagEnvironment = managedNetworkEnvironment(current, current.directory, "0.82.0");
    const lag = runDispatcher(dataRoot, ["update"], lagEnvironment);
    assert.equal(lag.status, 0, lag.stderr);
    assert.match(lag.stdout, /Patch Lag: pi-v0\.81\.1-patch\.6.*0\.81\.1.*0\.82\.0/s);

    const allEnvironment = managedNetworkEnvironment(candidate, candidate.directory);
    const all = runDispatcher(dataRoot, ["update", "--all", "--approve"], allEnvironment);
    assert.equal(all.status, 0, all.stderr);
    const managedPhase = all.stdout.indexOf("Managed Update phase:");
    const activated = all.stdout.indexOf("Activated Downstream Release pi-v0.81.1-patch.7");
    const packagePhase = all.stdout.indexOf("Package update phase (newly active Pi):");
    const packageInvocation = all.stdout.indexOf("<update> <--extensions> <--approve>");
    assert.ok(managedPhase >= 0 && managedPhase < activated && activated < packagePhase && packagePhase < packageInvocation, all.stdout);

    const laterEnvironment = managedNetworkEnvironment(later, later.directory);
    const partial = runDispatcher(dataRoot, ["update", "--all"], { ...laterEnvironment, PI_TEST_PACKAGE_EXIT: "17" });
    assert.equal(partial.status, 17, `${partial.stdout}\n${partial.stderr}`);
    assert.match(partial.stderr, /package update phase failed with exit code 17.*verified release remains active/i);
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.8");

    const currentPartial = runDispatcher(dataRoot, ["update", "--all"], { ...laterEnvironment, PI_TEST_PACKAGE_EXIT: "19" });
    assert.equal(currentPartial.status, 19, `${currentPartial.stdout}\n${currentPartial.stderr}`);
    assert.match(currentPartial.stderr, /completed as current without activation.*package update phase failed with exit code 19/i);

    const next = fixture({ releaseId: "pi-v0.81.1-patch.9", managerArchive: current.managerArchive });
    try {
      await checkManagedUpdate(dataRoot, { transport: updateTransport(next), now });
      for (const args of [["--print", "hello"], ["--mode", "json"], ["--mode", "rpc"]]) {
        const output = runDispatcher(dataRoot, args, { PI_SKIP_VERSION_CHECK: "" });
        assert.equal(output.status, 0, output.stderr);
        assert.doesNotMatch(`${output.stdout}${output.stderr}`, /compatible Downstream Release is available/);
      }
    } finally {
      destroy(next.directory);
    }
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
    destroy(candidate.directory);
    destroy(later.directory);
  }
});

test("interactive startup notices do not pollute TTY metadata and package-command output", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-interactive-output-"));
  const current = fixture();
  const candidate = fixture({ releaseId: "pi-v0.81.1-patch.7" });
  try {
    activate(dataRoot, current);
    await checkManagedUpdate(dataRoot, { transport: updateTransport(candidate), now });

    const interactive = runDispatcherInTty(dataRoot, ["--offline"]);
    assert.equal(interactive.status, 0, `${interactive.stdout}\n${interactive.stderr}`);
    assert.match(interactive.stdout, /compatible Downstream Release is available/);

    for (const args of [
      ["--help"], ["--version"], ["--list-models"], ["--export", "session.jsonl"], ["--mode", "text"], ["list"], ["conformance"],
    ]) {
      const output = runDispatcherInTty(dataRoot, [...args, "--offline"]);
      assert.equal(output.status, 0, `${output.stdout}\n${output.stderr}`);
      assert.doesNotMatch(output.stdout, /compatible Downstream Release is available/);
      if (args[0] === "conformance") assert.match(output.stdout, /Deferred conformance passed/);
    }
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
    destroy(candidate.directory);
  }
});

test("Managed Update serializes lifecycle work and refuses symlink-substituted status state", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-state-safety-"));
  const foreignRoot = mkdtempSync(join(tmpdir(), "managed-update-state-foreign-"));
  const current = fixture();
  try {
    activate(dataRoot, current);
    const blocked = withLifecycleLock(dataRoot, "held for update test", () => (
      checkManagedUpdate(dataRoot, { transport: updateTransport(current), now })
    ));
    await assert.rejects(blocked, /Managed lifecycle operation already active: held for update test/);

    const foreign = join(foreignRoot, "foreign.json");
    writeFileSync(foreign, "foreign\n");
    symlinkSync(foreign, join(dataRoot, "state", "update-status.json"));
    await assert.rejects(
      performManagedUpdate(dataRoot, { transport: updateTransport(current), now }),
      /managed state path is foreign/i,
    );
    assert.equal(readFileSync(foreign, "utf8"), "foreign\n");
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.6");
  } finally {
    destroy(dataRoot);
    destroy(foreignRoot);
    destroy(current.directory);
  }
});

test("Managed Update refuses a forged lifecycle-lock capability", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-forged-lock-"));
  const current = fixture();
  try {
    activate(dataRoot, current);
    await assert.rejects(
      checkManagedUpdate(dataRoot, { transport: updateTransport(current), now, lifecycleCapability: {} }),
      /Invalid managed lifecycle lock capability/,
    );
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.6");
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
  }
});

test("startup refresh rejects a symlink-substituted Managed Installation root before mutation", async () => {
  const parent = mkdtempSync(join(tmpdir(), "managed-update-symlink-root-"));
  const foreignRoot = mkdtempSync(join(tmpdir(), "managed-update-symlink-target-"));
  const dataRoot = join(parent, "managed");
  try {
    symlinkSync(foreignRoot, dataRoot);
    await assert.rejects(
      refreshManagedStartupStatus(dataRoot, { now }),
      /Managed state path is foreign/,
    );
    assert.deepEqual(readdirSync(foreignRoot), []);
  } finally {
    destroy(parent);
    destroy(foreignRoot);
  }
});

test("Managed Update preserves the old or complete new pair at every updater activation boundary", async () => {
  const boundaries = [
    "manager-staged", "downstream-staged", "metadata-accepted", "manager-published",
    "downstream-published", "before-activation-switch", "after-activation-switch",
  ];
  for (const boundary of boundaries) {
    const dataRoot = mkdtempSync(join(tmpdir(), `managed-update-boundary-${boundary}-`));
    const current = fixture();
    const candidate = fixture({ releaseId: "pi-v0.81.1-patch.7", managerArchive: current.managerArchive });
    try {
      activate(dataRoot, current);
      writeFileSync(join(dataRoot, "state", "update-hold.json"), serializeMetadata({
        schemaVersion: 1,
        type: "update-hold",
        releaseId: "pi-v0.81.1-patch.7",
        createdAt: now.toISOString(),
      }));
      await assert.rejects(
        performManagedUpdate(dataRoot, {
          transport: updateTransport(candidate),
          now,
          checkpoint(name) { if (name === boundary) throw new Error(`Interrupted at ${name}`); },
        }),
        new RegExp(`Interrupted at ${boundary}`),
      );
      const active = readActivation(dataRoot).active.downstreamReleaseId;
      assert.equal(active, boundary === "after-activation-switch" ? "pi-v0.81.1-patch.7" : "pi-v0.81.1-patch.6");
      if (boundary === "after-activation-switch") {
        assert.equal(existsSync(join(dataRoot, "state", "update-hold.json")), true);
        const retry = await performManagedUpdate(dataRoot, { transport: updateTransport(candidate), now });
        assert.equal(retry.kind, "current");
        assert.equal(existsSync(join(dataRoot, "state", "update-hold.json")), false);
      }
    } finally {
      destroy(dataRoot);
      destroy(current.directory);
      destroy(candidate.directory);
    }
  }
});

test("Manager and Downstream Release download failures are stage-specific and never switch Activation", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-download-failure-"));
  const current = fixture();
  const candidate = fixture({ releaseId: "pi-v0.81.1-patch.7", managerArchive: current.managerArchive });
  try {
    activate(dataRoot, current);
    const manifestUrl = candidate.channelEnvelope.signed.manifest.url;
    for (const [archivePath, expected] of [
      [candidate.managerArchive, /Manager Release download: manager unavailable/],
      [candidate.releaseArchive, /Downstream Release download: downstream unavailable/],
    ]) {
      const url = new URL(basename(archivePath), manifestUrl).href;
      await assert.rejects(
        performManagedUpdate(dataRoot, {
          transport: updateTransport(candidate, { fail: new Map([[url, expected.source.includes("Manager") ? "manager unavailable" : "downstream unavailable"]]) }),
          now,
        }),
        expected,
      );
      assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.6");
      assert.equal(readdirSync(join(dataRoot, "tmp")).some((name) => name.startsWith("update.tmp-")), false);
    }
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
    destroy(candidate.directory);
  }
});

test("Managed Update discovery and metadata-acceptance failures are stage-specific and preserve Activation", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-metadata-boundaries-"));
  const foreignRoot = mkdtempSync(join(tmpdir(), "managed-update-metadata-foreign-"));
  const current = fixture();
  const candidate = fixture({ releaseId: "pi-v0.81.1-patch.7", managerArchive: current.managerArchive });
  try {
    activate(dataRoot, current);
    const manifestUrl = candidate.channelEnvelope.signed.manifest.url;
    for (const [url, message, stage] of [
      ["https://example.test/release-trust.json", "trust unavailable", "trust discovery"],
      [candidate.trustEnvelope.signed.channelUrl, "Channel unavailable", "Channel discovery"],
      [manifestUrl, "manifest unavailable", "Release Manifest discovery"],
    ]) {
      await assert.rejects(
        performManagedUpdate(dataRoot, { transport: updateTransport(candidate, { fail: new Map([[url, message]]) }), now }),
        new RegExp(`Managed Update failed during ${stage}: ${message}`, "i"),
      );
      assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.6");
    }

    const accepted = join(dataRoot, "state", "accepted-metadata.json");
    const retainedAccepted = join(dataRoot, "state", "accepted-metadata.before-test.json");
    const foreign = join(foreignRoot, "foreign.json");
    writeFileSync(foreign, "foreign\n");
    const transport = updateTransport(candidate);
    const fetchJson = transport.json.bind(transport);
    transport.json = async (url, label) => {
      const value = await fetchJson(url, label);
      if (url === manifestUrl) {
        renameSync(accepted, retainedAccepted);
        symlinkSync(foreign, accepted);
      }
      return value;
    };
    await assert.rejects(
      performManagedUpdate(dataRoot, { transport, now }),
      /Managed Update failed during metadata acceptance: Malformed accepted metadata state/,
    );
    assert.equal(readFileSync(foreign, "utf8"), "foreign\n");
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.6");

    const stages = readdirSync(join(dataRoot, "diagnostics"))
      .map((name) => JSON.parse(readFileSync(join(dataRoot, "diagnostics", name), "utf8")))
      .filter((entry) => entry.type === "managed-update-failure")
      .map((entry) => entry.stage);
    for (const stage of ["trust discovery", "Channel discovery", "Release Manifest discovery", "metadata acceptance"]) {
      assert.ok(stages.includes(stage), `${stage}: ${JSON.stringify(stages)}`);
    }
  } finally {
    destroy(dataRoot);
    destroy(foreignRoot);
    destroy(current.directory);
    destroy(candidate.directory);
  }
});

test("post-activation cleanup failure reports a partial Managed Update without reverting the verified pair", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-post-activation-"));
  const current = fixture();
  const candidate = fixture({ releaseId: "pi-v0.81.1-patch.7", managerArchive: current.managerArchive });
  try {
    activate(dataRoot, current);
    writeFileSync(join(dataRoot, "state", "update-hold.json"), "{}\n");
    await assert.rejects(
      performManagedUpdate(dataRoot, { transport: updateTransport(candidate), now }),
      /Malformed Update Hold/,
    );
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.7");
    assert.equal(readdirSync(join(dataRoot, "tmp")).some((name) => name.startsWith("update.tmp-")), false);
    const diagnostics = readdirSync(join(dataRoot, "diagnostics"))
      .map((name) => JSON.parse(readFileSync(join(dataRoot, "diagnostics", name), "utf8")));
    assert.ok(diagnostics.some(
      (entry) => entry.type === "managed-update-failure" && entry.stage === "post-activation cleanup",
    ), JSON.stringify(diagnostics));
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
    destroy(candidate.directory);
  }
});

test("stale lifecycle recovery has one durable claim before a new owner mutates state", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-stale-lifecycle-"));
  const current = fixture();
  try {
    activate(dataRoot, current);
    writeFileSync(join(dataRoot, "state", "lifecycle.lock"), serializeMetadata({
      schemaVersion: 1,
      pid: 999_999_999,
      token: "stale-owner-token",
      operation: "interrupted update",
      startedAt: "2020-01-01T00:00:00.000Z",
    }));
    assert.equal(withLifecycleLock(dataRoot, "replacement update", () => "recovered"), "recovered");
    const recovery = readdirSync(join(dataRoot, "state")).find((name) => name.startsWith("lifecycle-recovery-"));
    assert.ok(recovery);
    assert.equal(JSON.parse(readFileSync(join(dataRoot, "state", recovery), "utf8")).staleToken, "stale-owner-token");
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
  }
});

test("stale lifecycle recovery resumes after interruption immediately after its durable claim", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-interrupted-recovery-"));
  const current = fixture();
  try {
    activate(dataRoot, current);
    const lock = join(dataRoot, "state", "lifecycle.lock");
    const staleToken = "interrupted-recovery-token";
    writeFileSync(lock, serializeMetadata({
      schemaVersion: 1,
      pid: 999_999_999,
      token: staleToken,
      operation: "interrupted update",
      startedAt: "2020-01-01T00:00:00.000Z",
    }));
    const recovery = join(dataRoot, "state", `lifecycle-recovery-${digest(staleToken)}.json`);
    linkSync(lock, recovery);

    assert.equal(withLifecycleLock(dataRoot, "resumed recovery", () => "recovered"), "recovered");
    assert.equal(JSON.parse(readFileSync(recovery, "utf8")).staleToken, staleToken);
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
  }
});

test("Patch Lag comparison follows SemVer prerelease ordering without numeric precision loss", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "managed-update-semver-"));
  const current = fixture({ upstreamVersion: "999999999999999999999.0.0-alpha.10" });
  try {
    activate(dataRoot, current);
    const older = await checkManagedUpdate(dataRoot, {
      transport: updateTransport(current, { upstreamVersion: "999999999999999999999.0.0-alpha.2" }),
      now,
    });
    assert.equal(older.kind, "current");
    const newer = await checkManagedUpdate(dataRoot, {
      transport: updateTransport(current, { upstreamVersion: "999999999999999999999.0.0-alpha.11" }),
      now,
    });
    assert.equal(newer.kind, "patch-lag");
    const invalid = await checkManagedUpdate(dataRoot, {
      transport: updateTransport(current, { upstreamVersion: "999999999999999999999.0.0-alpha.01" }),
      now,
    });
    assert.equal(invalid.kind, "current");
    assert.match(invalid.upstreamError, /Malformed upstream Pi latest-version response/);
  } finally {
    destroy(dataRoot);
    destroy(current.directory);
  }
});
