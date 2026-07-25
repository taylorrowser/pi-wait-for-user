import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  disableManagedCommandOwnership,
  enableManagedOwnership,
  installAndActivate,
  installManagedCompatibility,
  pruneManagedInstallation,
  readActivation,
  readManagedOwnership,
  recoverPrevious,
  rollbackManagedInstallation,
  uninstallManagedInstallation,
  verifyManagedInstallation,
} from "../scripts/lib/managed-runtime.mjs";
import { performManagedUpdate } from "../scripts/lib/managed-update.mjs";
import { createPayloadInventory, serializeMetadata, signMetadata } from "../scripts/lib/release-metadata.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const keys = join(root, "test", "fixtures", "release-keys");
const rootPrivate = readFileSync(join(keys, "root-private.pem"), "utf8");
const rootPublic = readFileSync(join(keys, "root-public.pem"), "utf8");
const releasePrivate = readFileSync(join(keys, "release-private.pem"), "utf8");
const releasePublic = readFileSync(join(keys, "release-public.pem"), "utf8");
const now = new Date("2026-07-24T12:00:00.000Z");
const platform = process.arch === "arm64" ? "windows-arm64" : "windows-x64";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(path) {
  const bytes = readFileSync(path);
  return { name: basename(path), sha256: digest(bytes), size: bytes.length };
}

function metadataArtifact(name, value) {
  return { name, sha256: digest(value), size: Buffer.byteLength(value) };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function compilePiFixture(directory) {
  const source = join(directory, "PiFixture.cs");
  const executable = join(directory, "pi-fixture.exe");
  writeFileSync(source, `using System;
using System.Threading;
public static class PiFixture {
  public static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "--version") { Console.WriteLine("0.81.1"); return 0; }
    if (args.Length > 0 && args[0] == "--help") { Console.WriteLine("Pi fixture help"); return 0; }
    if (args.Length > 0 && args[0] == "conformance") { Console.WriteLine("Deferred conformance passed (8/8)"); return 0; }
    var hold = Environment.GetEnvironmentVariable("PI_TEST_HOLD_MS");
    if (!String.IsNullOrEmpty(hold)) Thread.Sleep(Int32.Parse(hold));
    Console.WriteLine("PI_ARGS:" + String.Join(" ", args));
    return 0;
  }
}`);
  const escapedSource = source.replaceAll("'", "''");
  const escapedExecutable = executable.replaceAll("'", "''");
  run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath '${escapedSource}') -OutputAssembly '${escapedExecutable}' -OutputType ConsoleApplication`,
  ]);
  return executable;
}

function fixture({ directory, compiledPi, releaseId, managerId = "manager-windows-v1", sequence, managerArchive: providedManagerArchive }) {
  const fixtureRoot = join(directory, releaseId);
  const managerPayload = join(fixtureRoot, "manager-payload");
  const releasePayload = join(fixtureRoot, "release-payload");
  mkdirSync(join(managerPayload, "package", "scripts", "lib"), { recursive: true });
  mkdirSync(join(releasePayload, "pi-wait-for-user", "question-tool", "extensions"), { recursive: true });
  for (const file of ["managed-dispatcher.mjs", "managed-manager.mjs"]) {
    copyFileSync(join(root, "scripts", file), join(managerPayload, "package", "scripts", file));
  }
  for (const file of ["managed-command.mjs", "managed-runtime.mjs", "managed-update.mjs", "release-metadata.mjs"]) {
    copyFileSync(join(root, "scripts", "lib", file), join(managerPayload, "package", "scripts", "lib", file));
  }
  writeFileSync(join(managerPayload, "package", "manager.mjs"), "import './scripts/managed-manager.mjs';\n");
  writeFileSync(join(managerPayload, "package", "package.json"), `${JSON.stringify({
    name: "fixture-manager", version: "1.0.0",
    piWaitForUser: { managerReleaseId: managerId, compatibleReleaseManifestVersions: [1] },
  }, null, 2)}\n`);

  copyFileSync(compiledPi, join(releasePayload, "pi-wait-for-user", "pi-core.exe"));
  writeFileSync(join(releasePayload, "pi-wait-for-user", "question-tool", "extensions", "question-tool.ts"), "export {};\n");
  writeFileSync(join(releasePayload, "pi-wait-for-user", "question-tool", "package.json"), `${JSON.stringify({
    name: "@taylorrowser/pi-question-tool", version: "0.1.4",
    piWaitForUser: {
      coreProtocolVersions: [1], handlerId: "dev.taylorrowser.pi-question-tool.question",
      handlerVersion: 1, packageSchemaVersions: [1],
    },
  }, null, 2)}\n`);
  writeFileSync(join(releasePayload, "pi-wait-for-user", "release.json"), `${JSON.stringify({
    schemaVersion: 1, releaseId, platform,
  }, null, 2)}\n`);

  const managerArchive = providedManagerArchive || join(fixtureRoot, `${managerId}.tar.gz`);
  const releaseArchive = join(fixtureRoot, `${releaseId}-${platform}.zip`);
  if (!providedManagerArchive) run("tar", ["-czf", managerArchive, "-C", managerPayload, "."]);
  run("tar", ["-a", "-cf", releaseArchive, "-C", releasePayload, "."]);
  const manager = artifact(managerArchive);
  const downstream = artifact(releaseArchive);
  const installer = metadataArtifact("install.sh", "installer");
  const questionPackage = metadataArtifact("question-tool.tgz", "question");
  const gate = metadataArtifact("fixture-gate.json", "gate");
  const report = metadataArtifact("release-candidate.json", "passed");
  const notes = metadataArtifact("RELEASE_NOTES.md", "notes");
  const trustEnvelope = signMetadata({
    schemaVersion: 1, type: "release-trust", version: 3, expires: "2027-01-01T00:00:00.000Z",
    channelUrl: "https://example.test/channel.json",
    releaseKeys: [{
      keyId: "fixture-release", algorithm: "ed25519", publicKey: releasePublic,
      expires: "2026-12-01T00:00:00.000Z", revoked: false,
    }],
  }, "fixture-root", rootPrivate);
  const manifestEnvelope = signMetadata({
    schemaVersion: 1, type: "release-manifest", releaseId, tag: releaseId,
    publishedAt: "2026-07-24T10:00:00.000Z",
    upstream: {
      repository: "https://github.com/earendil-works/pi.git", tag: "v0.81.1",
      commit: "20be4b18d4c57487f8993d2762bace129f0cf7c6", packageVersion: "0.81.1",
    },
    patches: [{ order: 1, path: "patches/active/0001.patch", sha256: digest("patch"), size: 5 }],
    compatibility: {
      questionTool: {
        name: "@taylorrowser/pi-question-tool", version: "0.1.4",
        manifest: metadataArtifact("packages/question-tool/package.json", "question manifest"), package: questionPackage,
        coreProtocolVersions: [1], handlerId: "dev.taylorrowser.pi-question-tool.question",
        handlerVersion: 1, packageSchemaVersions: [1],
      },
      sessions: {
        identities: [{ id: "dev.taylorrowser.pi-wait-for-user/session", version: 1 }],
        readableCoreProtocolVersions: [1],
        readableHandlers: [{ id: "dev.taylorrowser.pi-question-tool.question", versions: [1] }],
      },
    },
    manager: { releaseId: managerId, compatibleReleaseManifestVersions: [1], artifacts: [manager] },
    bootstrap: { installer },
    platformArchives: [{ platform, artifact: downstream, payload: createPayloadInventory(releasePayload) }],
    releaseGates: [{ name: "release-candidate", status: "passed", definition: gate, report }],
    provenance: {
      repository: "taylorrowser/pi-wait-for-user", workflow: ".github/workflows/release.yml",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      artifacts: [manager, questionPackage, installer, downstream, gate, report, notes]
        .map(({ name, sha256 }) => ({ name, sha256 })).sort((a, b) => a.name.localeCompare(b.name)),
    },
    releaseNotes: notes,
  }, "fixture-release", releasePrivate);
  const channelEnvelope = signMetadata({
    schemaVersion: 1, type: "release-channel", sequence, expires: "2026-08-01T00:00:00.000Z",
    manifest: {
      releaseId, url: `https://example.test/${releaseId}/release-manifest.json`,
      sha256: digest(serializeMetadata(manifestEnvelope)),
    },
  }, "fixture-release", releasePrivate);
  return {
    platform, managerArchive, releaseArchive, trustEnvelope, channelEnvelope, manifestEnvelope,
    rootKeys: new Map([["fixture-root", rootPublic]]),
  };
}

function markPinned(dataRoot) {
  const path = join(dataRoot, "state", "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.rootKeyProvenance.type = "installer-pinned";
  config.rootKeyProvenance.configurationSha256 = digest(serializeMetadata({
    type: "installer-pinned", keys: config.rootKeys,
  }));
  writeFileSync(path, serializeMetadata(config));
}

function activate(dataRoot, candidate, checkpoint) {
  const activation = installAndActivate({ dataRoot, now, checkpoint, ...candidate });
  markPinned(dataRoot);
  return activation;
}

const nativeWindows = process.platform === "win32";

test("native Windows x64/ARM64 lifecycle preserves ownership, Activation, leases, rollback, recovery, and shared data", { skip: !nativeWindows }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "managed-windows-native-"));
  const home = join(directory, "user");
  const dataRoot = join(directory, "managed");
  const bin = join(directory, "bin");
  const stockBin = join(directory, "stock-bin");
  const shared = join(home, ".pi", "agent");
  mkdirSync(shared, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(stockBin, { recursive: true });
  writeFileSync(join(shared, "settings.json"), "preserve exactly\n");
  writeFileSync(join(stockBin, "pi.cmd"), "@echo off\r\nif \"%~1\"==\"--version\" echo 0.81.1-stock\r\n");
  const collisionRoot = join(directory, "PowerShell-collision-must-remain-absent");
  const installerPath = join(root, "scripts", "install-windows.ps1").replaceAll("'", "''");
  const collisionPath = collisionRoot.replaceAll("'", "''");
  const powerShellCollision = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    `function pi { 'foreign PowerShell function' }; & '${installerPath}' -ManagePi -DataRoot '${collisionPath}'`,
  ], { encoding: "utf8", windowsHide: true });
  assert.notEqual(powerShellCollision.status, 0);
  assert.match(powerShellCollision.stderr, /PowerShell command collision: pi/i);
  assert.equal(existsSync(collisionRoot), false);
  const compiledPi = compilePiFixture(directory);
  const first = fixture({ directory, compiledPi, releaseId: "pi-v0.81.1-patch.11", sequence: 11 });
  const second = fixture({ directory, compiledPi, releaseId: "pi-v0.81.1-patch.12", sequence: 12, managerArchive: first.managerArchive });
  const third = fixture({ directory, compiledPi, releaseId: "pi-v0.81.1-patch.13", sequence: 13, managerArchive: first.managerArchive });
  const fourth = fixture({ directory, compiledPi, releaseId: "pi-v0.81.1-patch.14", sequence: 14, managerArchive: first.managerArchive });
  const environment = {
    ...process.env, USERPROFILE: home, HOME: home, PATH: `${bin};${stockBin};${process.env.PATH}`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD", PI_SKIP_VERSION_CHECK: "1",
  };
  try {
    activate(dataRoot, first);
    writeFileSync(join(bin, "pi.exe"), "foreign");
    assert.throws(() => enableManagedOwnership(dataRoot, { binDirectory: bin, environment }), /foreign command collision/i);
    rmSync(join(bin, "pi.exe"));
    installManagedCompatibility(dataRoot, { binDirectory: bin, environment });
    assert.equal(enableManagedOwnership(dataRoot, { binDirectory: bin, environment }), "enabled");
    const ownership = readManagedOwnership(dataRoot);
    assert.equal(ownership.stock.resolvedPath.toLowerCase(), join(stockBin, "pi.cmd").toLowerCase());
    assert.equal(readFileSync(join(shared, "settings.json"), "utf8"), "preserve exactly\n");

    assert.throws(() => activate(dataRoot, second, (name) => {
      if (name === "before-activation-switch") throw new Error("interrupted before switch");
    }), /interrupted before switch/);
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.11");
    const patchOnlyUpdate = await performManagedUpdate(dataRoot, {
      now,
      transport: {
        async json(_url, label) {
          if (label === "release trust metadata") return second.trustEnvelope;
          if (label === "Release Channel") return second.channelEnvelope;
          if (label === "Release Manifest") return second.manifestEnvelope;
          return { version: "0.81.1" };
        },
        async artifact(_url, destination, label) {
          copyFileSync(label === "Manager Release" ? second.managerArchive : second.releaseArchive, destination);
        },
      },
    });
    assert.equal(patchOnlyUpdate.kind, "activated");
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.12");
    assert.equal(rollbackManagedInstallation(dataRoot).kind, "rolled-back");
    assert.equal(readActivation(dataRoot).active.downstreamReleaseId, "pi-v0.81.1-patch.11");
    activate(dataRoot, second);

    const runningPair = readActivation(dataRoot).active;
    const running = spawn(process.execPath, [join(root, "scripts", "managed-dispatcher.mjs"), "--fixture-running"], {
      env: { ...environment, PI_MANAGED_DATA_ROOT: dataRoot, PI_TEST_HOLD_MS: "20000" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let runningOutput = "";
    running.stdout.on("data", (chunk) => { runningOutput += chunk; });
    running.stderr.on("data", (chunk) => { runningOutput += chunk; });
    const leaseRoot = join(dataRoot, "leases", `${runningPair.managerReleaseId}--${runningPair.downstreamReleaseId}`);
    const leaseDeadline = Date.now() + 10_000;
    while ((!existsSync(leaseRoot) || readdirSync(leaseRoot).length === 0) && running.exitCode === null && Date.now() < leaseDeadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    assert.equal(
      running.exitCode === null && existsSync(leaseRoot) && readdirSync(leaseRoot).length > 0,
      true,
      `Dispatcher did not retain its process lease: ${runningOutput}`,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    assert.equal(running.exitCode, null, `Dispatcher exited before its Pi process lifetime ended: ${runningOutput}`);
    activate(dataRoot, third);
    activate(dataRoot, fourth);
    assert.equal(
      existsSync(join(dataRoot, "downstream-releases", runningPair.downstreamReleaseId)),
      true,
      `Active-process payload was removed: ${runningOutput}`,
    );
    await new Promise((resolveExit, reject) => {
      running.once("error", reject);
      running.once("exit", resolveExit);
    });
    pruneManagedInstallation(dataRoot);
    assert.equal(existsSync(join(dataRoot, "downstream-releases", runningPair.downstreamReleaseId)), false);

    const active = readActivation(dataRoot);
    const core = join(dataRoot, "downstream-releases", active.active.downstreamReleaseId, "pi-wait-for-user", "pi-core.exe");
    chmodSync(core, 0o666);
    rmSync(core);
    const failed = spawnSync(process.execPath, [join(root, "scripts", "managed-dispatcher.mjs"), "--version"], {
      encoding: "utf8", env: { ...environment, PI_MANAGED_DATA_ROOT: dataRoot }, windowsHide: true,
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /failed closed/i);
    recoverPrevious(dataRoot);
    verifyManagedInstallation(dataRoot);
    copyFileSync(compiledPi, core); // Restore the now-inactive fixture so receipt-safe uninstall can verify every pair.

    assert.equal(disableManagedCommandOwnership(dataRoot), "disabled");
    assert.equal(existsSync(join(bin, "pi.cmd")), false);
    assert.equal(existsSync(join(stockBin, "pi.cmd")), true);
    const result = uninstallManagedInstallation(dataRoot, { environment });
    assert.equal(result.kind, "uninstalled");
    assert.equal(readFileSync(join(shared, "settings.json"), "utf8"), "preserve exactly\n");
    assert.equal(existsSync(join(stockBin, "pi.cmd")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
