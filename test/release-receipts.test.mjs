import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { serializeMetadata, signMetadata } from "../scripts/lib/release-metadata.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const metadataCli = join(repositoryRoot, "scripts", "release-metadata.mjs");
const fixtureKeys = join(repositoryRoot, "test", "fixtures", "release-keys");
const rootPrivate = readFileSync(join(fixtureKeys, "root-private.pem"), "utf8");
const releasePrivate = readFileSync(join(fixtureKeys, "release-private.pem"), "utf8");
const releasePublic = readFileSync(join(fixtureKeys, "release-public.pem"), "utf8");
const now = "2026-07-24T12:00:00.000Z";
const expectedPlatforms = ["darwin-arm64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"];
const expectedOutputs = expectedPlatforms.map((platform) => `installation-receipt-${platform}.json`);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(name) {
  return { name, sha256: digest(name), size: Buffer.byteLength(name) };
}

function writeAuthority(directory, releaseKeyId = "fixture-release-2026") {
  const path = join(directory, "authority", "release-trust.json");
  mkdirSync(dirname(path), { recursive: true });
  if (releaseKeyId === "fixture-release-2026") {
    writeFileSync(path, readFileSync(join(fixtureKeys, "release-trust.json")));
    return path;
  }
  const trust = signMetadata({
    schemaVersion: 1,
    type: "release-trust",
    version: 1,
    expires: "2027-01-01T00:00:00.000Z",
    channelUrl: "https://example.test/channel.json",
    releaseKeys: [{
      keyId: releaseKeyId,
      algorithm: "ed25519",
      publicKey: releasePublic,
      expires: "2027-01-01T00:00:00.000Z",
      revoked: false,
    }],
  }, "fixture-root-2026", rootPrivate);
  writeFileSync(path, serializeMetadata(trust));
  return path;
}

function writeManifest(directory, platforms = [
  "darwin-arm64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64",
], releaseKeyId = "fixture-release-2026", releasePrivateKey = releasePrivate) {
  const manager = artifact("pi-wait-for-user-pi-v0.81.1-patch.11.tgz");
  const questionPackage = artifact("taylorrowser-pi-question-tool-0.1.4.tgz");
  const installer = artifact("install.sh");
  const gate = artifact("fixture-gate.json");
  const report = artifact("release-candidate.json");
  const notes = artifact("RELEASE_NOTES.md");
  const archives = platforms.map((platform) => ({
    platform,
    artifact: artifact(`pi-wait-for-user-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`),
    payload: [{
      path: "pi-wait-for-user/pi-core",
      sha256: digest(`binary-${platform}`),
      size: Buffer.byteLength(`binary-${platform}`),
      mode: 493,
    }],
  }));
  const provenanceArtifacts = [
    manager, questionPackage, installer, ...archives.map(({ artifact: archive }) => archive), gate, report, notes,
  ].sort((left, right) => left.name.localeCompare(right.name)).map(({ name, sha256 }) => ({ name, sha256 }));
  const manifest = signMetadata({
    schemaVersion: 1,
    type: "release-manifest",
    releaseId: "pi-v0.81.1-patch.11",
    tag: "pi-v0.81.1-patch.11",
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
        version: "0.1.4",
        manifest: artifact("packages/question-tool/package.json"),
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
    manager: { releaseId: "manager-v2", compatibleReleaseManifestVersions: [1], artifacts: [manager] },
    bootstrap: { installer },
    platformArchives: archives,
    releaseGates: [{ name: "release-candidate", status: "passed", definition: gate, report }],
    provenance: {
      repository: "taylorrowser/pi-wait-for-user",
      workflow: ".github/workflows/release.yml",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      artifacts: provenanceArtifacts,
    },
    releaseNotes: notes,
  }, releaseKeyId, releasePrivateKey);
  const path = join(directory, "dist", "pi-v0.81.1-patch.11", "release-manifest.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeMetadata(manifest));
  return path;
}

function runReceipts(directory, manifest, output, extra = []) {
  return spawnSync(process.execPath, [metadataCli, "receipts",
    "--manifest", manifest,
    "--trust", "authority/release-trust.json",
    "--root-key", `fixture-root-2026=${join(fixtureKeys, "root-public.pem")}`,
    "--now", now,
    "--owned-path", "$MANAGED_DATA_ROOT/downstream-releases/pi-v0.81.1-patch.11",
    "--output", output,
    ...extra,
  ], { cwd: directory, encoding: "utf8" });
}

function preflightOptions(directory, reportPath) {
  return ["--preflight-report", reportPath, "--summary", join(directory, "workflow-summary.md")];
}

test("receipt projection loads workspace-relative and absolute generated manifests through one CLI boundary", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-receipts-paths-"));
  try {
    writeAuthority(directory);
    const manifestPath = writeManifest(directory);
    const relativeManifest = "dist/pi-v0.81.1-patch.11/release-manifest.json";

    const relative = runReceipts(directory, relativeManifest, "relative-output");
    assert.equal(relative.status, 0, relative.stderr);
    assert.deepEqual(readdirSync(join(directory, "relative-output")).sort(), expectedOutputs);

    const absolute = runReceipts(directory, resolve(manifestPath), "absolute-output");
    assert.equal(absolute.status, 0, absolute.stderr);
    assert.deepEqual(readdirSync(join(directory, "absolute-output")).sort(), expectedOutputs);
    for (const platform of expectedPlatforms) {
      const receipt = JSON.parse(readFileSync(join(directory, "relative-output", `installation-receipt-${platform}.json`), "utf8"));
      assert.equal(receipt.platform, platform);
      assert.equal(receipt.releaseId, "pi-v0.81.1-patch.11");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("receipt projection rejects missing supported outputs and unsupported Intel macOS", () => {
  for (const [name, platforms] of [
    ["missing Linux ARM64", ["darwin-arm64", "linux-x64", "windows-arm64", "windows-x64"]],
    ["missing Windows ARM64", ["darwin-arm64", "linux-arm64", "linux-x64", "windows-x64"]],
    ["unsupported Intel macOS", [
      "darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64",
    ]],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "release-receipts-inventory-"));
    try {
      writeAuthority(directory);
      writeManifest(directory, platforms);
      const reportPath = join(directory, "preflight-report.json");
      const result = runReceipts(
        directory,
        "dist/pi-v0.81.1-patch.11/release-manifest.json",
        "output",
        preflightOptions(directory, reportPath),
      );
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /platform inventory must be exactly/i, name);
      assert.equal(existsSync(reportPath), false, name);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("receipt projection rejects missing, malformed, and unexpected output inputs without a success report", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-receipts-fail-closed-"));
  try {
    writeAuthority(directory);
    const reportPath = join(directory, "preflight-report.json");
    const missing = runReceipts(
      directory,
      "dist/missing/release-manifest.json",
      "missing-output",
      preflightOptions(directory, reportPath),
    );
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Missing Release Manifest/);

    const malformedPath = join(directory, "dist", "malformed", "release-manifest.json");
    mkdirSync(dirname(malformedPath), { recursive: true });
    writeFileSync(malformedPath, "not JSON\n");
    const malformed = runReceipts(
      directory,
      "dist/malformed/release-manifest.json",
      "malformed-output",
      preflightOptions(directory, reportPath),
    );
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /Malformed Release Manifest JSON/);

    writeManifest(directory);
    mkdirSync(join(directory, "extra-output"));
    writeFileSync(join(directory, "extra-output", "installation-receipt-darwin-x64.json"), "{}\n");
    const extra = runReceipts(
      directory,
      "dist/pi-v0.81.1-patch.11/release-manifest.json",
      "extra-output",
      preflightOptions(directory, reportPath),
    );
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /output inventory must be empty/i);
    assert.equal(existsSync(reportPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("receipt preflight refuses authority that is not explicitly identified as a public fixture", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-receipts-authority-"));
  try {
    writeAuthority(directory, "release-2026-1");
    writeManifest(directory, undefined, "release-2026-1");
    const manifestPath = "dist/pi-v0.81.1-patch.11/release-manifest.json";
    const production = runReceipts(directory, manifestPath, "production-output");
    assert.equal(production.status, 0, production.stderr);

    const reportPath = join(directory, "preflight-report.json");
    const result = runReceipts(
      directory,
      manifestPath,
      "preflight-output",
      preflightOptions(directory, reportPath),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public fixture authority/i);
    assert.equal(existsSync(reportPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("receipt preflight rejects arbitrary delegated keys that reuse the fixture key IDs", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-receipts-authority-identity-"));
  try {
    const arbitraryRelease = generateKeyPairSync("ed25519");
    const arbitraryReleasePublic = arbitraryRelease.publicKey.export({ type: "spki", format: "pem" }).toString();
    const arbitraryReleasePrivate = arbitraryRelease.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const trust = signMetadata({
      schemaVersion: 1,
      type: "release-trust",
      version: 1,
      expires: "2027-01-01T00:00:00.000Z",
      channelUrl: "https://example.test/fixture-channel.json",
      releaseKeys: [{
        keyId: "fixture-release-2026",
        algorithm: "ed25519",
        publicKey: arbitraryReleasePublic,
        expires: "2027-01-01T00:00:00.000Z",
        revoked: false,
      }],
    }, "fixture-root-2026", rootPrivate);
    const trustPath = join(directory, "authority", "release-trust.json");
    mkdirSync(dirname(trustPath), { recursive: true });
    writeFileSync(trustPath, serializeMetadata(trust));
    writeManifest(directory, undefined, "fixture-release-2026", arbitraryReleasePrivate);
    const reportPath = join(directory, "preflight-report.json");

    const result = runReceipts(
      directory,
      "dist/pi-v0.81.1-patch.11/release-manifest.json",
      "output",
      preflightOptions(directory, reportPath),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public fixture authority/i);
    assert.equal(existsSync(reportPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("receipt preflight cannot create a passing machine report without its required workflow summary", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-receipts-summary-required-"));
  try {
    writeAuthority(directory);
    writeManifest(directory);
    const reportPath = join(directory, "production-receipt-preflight.json");
    writeFileSync(reportPath, '{"result":"passed","stale":true}\n');

    const result = runReceipts(
      directory,
      "dist/pi-v0.81.1-patch.11/release-manifest.json",
      "preflight-output",
      ["--preflight-report", reportPath],
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /summary.*required|required.*summary/i);
    assert.equal(existsSync(reportPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("receipt preflight clears stale machine evidence before validating required inputs", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-receipts-required-input-"));
  try {
    writeAuthority(directory);
    const reportPath = join(directory, "production-receipt-preflight.json");
    writeFileSync(reportPath, '{"result":"passed","stale":true}\n');

    const result = spawnSync(process.execPath, [metadataCli, "receipts",
      "--trust", "authority/release-trust.json",
      "--root-key", `fixture-root-2026=${join(fixtureKeys, "root-public.pem")}`,
      "--now", now,
      "--owned-path", "$MANAGED_DATA_ROOT/downstream-releases/pi-v0.81.1-patch.11",
      "--output", "preflight-output",
      "--preflight-report", reportPath,
      "--summary", join(directory, "workflow-summary.md"),
    ], { cwd: directory, encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing required option: --manifest/);
    assert.equal(existsSync(reportPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("receipt preflight clears stale machine evidence before rejecting unknown options", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-receipts-unknown-option-"));
  try {
    writeAuthority(directory);
    writeManifest(directory);
    const reportPath = join(directory, "production-receipt-preflight.json");
    writeFileSync(reportPath, '{"result":"passed","stale":true}\n');

    const result = runReceipts(
      directory,
      "dist/pi-v0.81.1-patch.11/release-manifest.json",
      "preflight-output",
      [...preflightOptions(directory, reportPath), "--unknown-option", "value"],
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown option: --unknown-option/);
    assert.equal(existsSync(reportPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("receipt preflight clears stale machine evidence before malformed option parsing", () => {
  for (const [name, malformedOptions] of [
    ["trailing option", ["--unknown-option"]],
    ["duplicate option", ["--summary", "duplicate-summary.md"]],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "release-receipts-malformed-options-"));
    try {
      const reportPath = join(directory, "production-receipt-preflight.json");
      writeFileSync(reportPath, '{"result":"passed","stale":true}\n');

      const result = runReceipts(
        directory,
        "dist/pi-v0.81.1-patch.11/release-manifest.json",
        "preflight-output",
        [...preflightOptions(directory, reportPath), ...malformedOptions],
      );

      assert.notEqual(result.status, 0, name);
      assert.equal(existsSync(reportPath), false, name);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("receipt preflight leaves no passing machine report when workflow summary writing fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-receipts-summary-failure-"));
  try {
    writeAuthority(directory);
    writeManifest(directory);
    const reportPath = join(directory, "evidence", "production-receipt-preflight.json");
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, '{"result":"passed","stale":true}\n');
    const summaryPath = join(directory, "summary-is-a-directory");
    mkdirSync(summaryPath);

    const result = runReceipts(
      directory,
      "dist/pi-v0.81.1-patch.11/release-manifest.json",
      "preflight-output",
      ["--preflight-report", reportPath, "--summary", summaryPath],
    );

    assert.notEqual(result.status, 0);
    assert.equal(existsSync(reportPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("receipt preflight reports exact inventory and fail-closed input probes without production material", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-receipts-preflight-"));
  try {
    writeAuthority(directory);
    writeManifest(directory);
    const reportPath = join(directory, "evidence", "production-receipt-preflight.json");
    const summaryPath = join(directory, "workflow-summary.md");

    const result = runReceipts(
      directory,
      "dist/pi-v0.81.1-patch.11/release-manifest.json",
      "preflight-output",
      ["--preflight-report", reportPath, "--summary", summaryPath],
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), {
      schemaVersion: 1,
      type: "production-receipt-preflight",
      result: "passed",
      releaseId: "pi-v0.81.1-patch.11",
      authority: {
        rootKeyId: "fixture-root-2026",
        rootSpkiSha256: "463b162316bb6e680f37b9203566df7b5efdaaf44c3906b807173314be800f5e",
        trustEnvelopeSha256: "0344a2669e5a6ad787f1b7c196f109aee4ceb0008fe20c2a6a4c96e7ddb7c52d",
        releaseKeys: [{
          keyId: "fixture-release-2026",
          spkiSha256: "4599deb1ddc5c67edffebaff0a1953f02d5f572bf9892b34b08c01a6ba727d96",
        }],
      },
      expectedPlatforms,
      expectedOutputs,
      manifestLoading: {
        workspaceRelative: "passed",
        absolute: "passed",
      },
      failClosedProbes: {
        missingManifest: "passed",
        malformedManifest: "passed",
      },
    });
    assert.deepEqual(readdirSync(join(directory, "preflight-output")).sort(), expectedOutputs);
    assert.match(readFileSync(summaryPath, "utf8"), /Production receipt preflight: passed/);
    assert.match(readFileSync(summaryPath, "utf8"), /darwin-arm64, linux-arm64, linux-x64, windows-arm64, windows-x64/);
    assert.match(readFileSync(summaryPath, "utf8"), /missing and malformed Release Manifest probes failed closed/);
    assert.doesNotMatch(result.stdout + result.stderr + readFileSync(summaryPath, "utf8"), /PRIVATE KEY|BEGIN [A-Z ]*PRIVATE/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
