import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { serializeMetadata, signMetadata } from "../scripts/lib/release-metadata.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseCli = join(repositoryRoot, "scripts", "release.mjs");
const releaseGateCli = join(repositoryRoot, "scripts", "release-gate.mjs");
const releaseMetadataCli = join(repositoryRoot, "scripts", "release-metadata.mjs");
const fixtureKeys = join(repositoryRoot, "test", "fixtures", "release-keys");
const releaseCandidateId = `pi-v${JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).version}`;
const releaseCandidateInput = JSON.parse(
  readFileSync(join(repositoryRoot, "releases", releaseCandidateId, "manifest.json"), "utf8"),
);
const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function copyReleaseFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-release-test-"));
  temporaryRoots.push(root);
  for (const path of [
    "README.md",
    "releases",
    "package.json",
    "upstream",
    "patches",
    "packages/question-tool/package.json",
    "scripts/bootstrap.sh",
    "scripts/install-binary.sh",
    "scripts/lib",
  ]) {
    cpSync(join(repositoryRoot, path), join(root, path), { recursive: true });
  }
  return root;
}

function copyBundleFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-release-bundle-source-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const path of [
    "LICENSE",
    "README.md",
    "package.json",
    "packages/question-tool",
    "patches",
    "releases",
    "scripts/bootstrap.sh",
    "scripts/install-binary.sh",
    "scripts/install.mjs",
    "scripts/launch.mjs",
    "scripts/lib",
    "scripts/package-binaries.mjs",
    "scripts/pi-patch.mjs",
    "scripts/release.mjs",
    "upstream",
  ]) {
    cpSync(join(repositoryRoot, path), join(root, path), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(join(root, "releases", releaseCandidateId, "manifest.json"), "utf8"));
  const gate = JSON.parse(readFileSync(join(root, manifest.fixtureGate.path), "utf8"));
  const stages = gate.requiredStages.map((name) => ({
    name,
    status: "passed",
    ...(name === "public-conformance" ? { result: { passed: 8, required: 8 } } : {}),
  }));
  const report = {
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    upstream: manifest.upstream,
    result: "passed",
    fixtureCategories: gate.categories,
    stages,
  };
  mkdirSync(join(root, "releases", manifest.releaseId, "reports"), { recursive: true });
  writeFileSync(
    join(root, "releases", manifest.releaseId, "reports", "release-candidate.json"),
    JSON.stringify(report),
  );
  return root;
}

function verify(root) {
  return spawnSync(process.execPath, [releaseCli, "verify", root], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

test("the release candidate input verifies every pinned identity without becoming an active Channel pointer", () => {
  const result = verify(repositoryRoot);

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(`Verified ${releaseCandidateId.replaceAll(".", "\\.")}: Pi v0\\.81\\.1, 13 patches, Question Tool ${releaseCandidateInput.questionTool.version.replaceAll(".", "\\.")}`),
  );
});

test("the repository does not carry an independent active release pointer", () => {
  const root = copyReleaseFixture();

  const result = verify(root);

  assert.equal(existsSync(join(root, "releases", "active.json")), false);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Verified ${releaseCandidateId.replaceAll(".", "\\.")}`));
});

test("the release gate lists every required fixture category", () => {
  const result = spawnSync(process.execPath, [releaseGateCli, "--list"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  for (const category of [
    "legacy", "markerless", "deferred", "ready", "partial", "complete", "unavailable",
    "incompatible-version", "compaction", "branch", "queue", "abandonment", "rpc", "json",
    "print", "tui", "question-tool",
  ]) {
    assert.match(result.stdout, new RegExp(`^${category}$`, "m"));
  }
});

test("a passing release stages complete artifacts and a manifest for signing", () => {
  const root = copyBundleFixture();
  const output = join(root, "assets");
  const binaries = join(root, "binaries");
  mkdirSync(binaries);
  for (const name of [
    "pi-wait-for-user-darwin-arm64.tar.gz",
    "pi-wait-for-user-darwin-x64.tar.gz",
    "pi-wait-for-user-linux-arm64.tar.gz",
    "pi-wait-for-user-linux-x64.tar.gz",
    "pi-wait-for-user-windows-arm64.zip",
    "pi-wait-for-user-windows-x64.zip",
  ]) {
    const contents = `fixture ${name}\n`;
    writeFileSync(join(binaries, name), contents);
    const platform = name.replace(/^pi-wait-for-user-/, "").replace(/\.(?:tar\.gz|zip)$/, "");
    writeFileSync(join(binaries, `${name}.metadata.json`), JSON.stringify({
      schemaVersion: 1,
      platform,
      artifact: {
        name,
        sha256: createHash("sha256").update(contents).digest("hex"),
        size: Buffer.byteLength(contents),
      },
      archiveMetadata: {
        schemaVersion: 1,
        releaseId: releaseCandidateId,
        upstream: releaseCandidateInput.upstream,
        platform,
        questionTool: { name: releaseCandidateInput.questionTool.name, version: releaseCandidateInput.questionTool.version },
      },
      payload: [{
        path: "pi-wait-for-user/pi-core",
        sha256: createHash("sha256").update("fixture core").digest("hex"),
        size: 12,
        mode: 493,
      }],
    }));
  }

  const result = spawnSync(process.execPath, [join(root, "scripts", "release.mjs"), "bundle", output, binaries], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, RELEASE_SOURCE_COMMIT: "0".repeat(40) },
  });

  assert.equal(result.status, 0, result.stderr);
  const trustPath = join(root, "trust.json");
  const manifestPath = join(output, "release-manifest.json");
  const rootPrivate = readFileSync(join(fixtureKeys, "root-private.pem"), "utf8");
  const releasePublic = readFileSync(join(fixtureKeys, "release-public.pem"), "utf8");
  writeFileSync(trustPath, serializeMetadata(signMetadata({
    schemaVersion: 1,
    type: "release-trust",
    version: 1,
    expires: "2027-01-01T00:00:00.000Z",
    channelUrl: "https://example.test/channel.json",
    releaseKeys: [{
      keyId: "fixture-release",
      algorithm: "ed25519",
      publicKey: releasePublic,
      expires: "2027-01-01T00:00:00.000Z",
      revoked: false,
    }],
  }, "fixture-root", rootPrivate)));
  const authority = [
    "--trust", trustPath,
    "--root-key", `fixture-root=${join(fixtureKeys, "root-public.pem")}`,
    "--now", "2026-07-24T12:00:00.000Z",
  ];
  const signed = spawnSync(process.execPath, [releaseMetadataCli, "sign-manifest",
    "--input", join(output, ".release-metadata", "unsigned-manifest.json"),
    "--provenance", join(output, ".release-metadata", "provenance-request.json"),
    ...authority,
    "--key-id", "fixture-release",
    "--private-key", join(fixtureKeys, "release-private.pem"),
    "--release-root", root,
    "--output", manifestPath,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(signed.status, 0, signed.stderr);
  const promoted = spawnSync(process.execPath, [releaseMetadataCli, "promote",
    "--manifest", manifestPath,
    ...authority,
    "--key-id", "fixture-release",
    "--private-key", join(fixtureKeys, "release-private.pem"),
    "--sequence", "1",
    "--expires", "2026-08-01T00:00:00.000Z",
    "--manifest-url", `https://example.test/${releaseCandidateId}/release-manifest.json`,
    "--bootstrap", "true",
    "--output", output,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(promoted.status, 0, promoted.stderr);

  const files = readdirSync(output);
  assert.ok(files.includes(`pi-wait-for-user-${releaseCandidateId}.tgz`));
  const packageListing = spawnSync("tar", ["-tzf", join(output, `pi-wait-for-user-${releaseCandidateId}.tgz`)], { encoding: "utf8" });
  assert.equal(packageListing.status, 0, packageListing.stderr);
  assert.doesNotMatch(packageListing.stdout, /release-keys|private\.pem/);
  assert.ok(files.includes(`taylorrowser-pi-question-tool-${releaseCandidateInput.questionTool.version}.tgz`));
  assert.ok(files.includes("install.sh"));
  assert.ok(files.includes("pi-wait-for-user-darwin-arm64.tar.gz"));
  assert.ok(files.includes("pi-wait-for-user-linux-x64.tar.gz"));
  const unsigned = JSON.parse(readFileSync(join(output, ".release-metadata", "unsigned-manifest.json"), "utf8"));
  assert.equal(unsigned.releaseId, releaseCandidateId);
  assert.equal(unsigned.platformArchives.length, 6);
  assert.deepEqual(unsigned.manager.artifacts.map((entry) => entry.name), [`pi-wait-for-user-${releaseCandidateId}.tgz`]);
  assert.equal(unsigned.compatibility.questionTool.package.name, `taylorrowser-pi-question-tool-${releaseCandidateInput.questionTool.version}.tgz`);
  assert.equal(unsigned.bootstrap.installer.name, "install.sh");
  assert.equal(unsigned.releaseGates[0].definition.name, "fixture-gate.json");
  assert.equal(unsigned.provenance.repository, "taylorrowser/pi-wait-for-user");
  assert.equal(existsSync(join(output, "SHA256SUMS")), true);
  assert.equal(existsSync(join(output, "artifact-manifest.json")), true);
  assert.equal(existsSync(join(output, "active.json")), true);

  const verified = spawnSync(process.execPath, [releaseMetadataCli, "verify",
    "--manifest", manifestPath,
    "--channel", join(output, "channel.json"),
    ...authority,
    "--release-root", root,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);

  writeFileSync(join(root, "scripts", "bootstrap.sh"), `${readFileSync(join(root, "scripts", "bootstrap.sh"), "utf8")}\n# drift\n`);
  const drifted = spawnSync(process.execPath, [releaseMetadataCli, "verify",
    "--manifest", manifestPath,
    "--channel", join(output, "channel.json"),
    ...authority,
    "--release-root", root,
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(drifted.status, 0);
  assert.match(drifted.stderr, /bootstrap installer projection drift/i);
});

test("bundling refuses an incomplete required gate even if marked passed", () => {
  const root = copyReleaseFixture();
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(releaseCli, join(root, "scripts", "release.mjs"));
  const manifest = JSON.parse(readFileSync(join(root, "releases", releaseCandidateId, "manifest.json"), "utf8"));
  const gate = JSON.parse(readFileSync(join(root, manifest.fixtureGate.path), "utf8"));
  const reportDirectory = join(root, "releases", releaseCandidateId, "reports");
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(join(reportDirectory, "release-candidate.json"), JSON.stringify({
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    upstream: manifest.upstream,
    result: "passed",
    fixtureCategories: gate.categories,
    stages: [],
  }));
  const output = join(root, "dist");

  const result = spawnSync(process.execPath, [join(root, "scripts", "release.mjs"), "bundle", output], {
    cwd: root,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Release report stages/);
  assert.equal(existsSync(output), false);
});

test("bundling refuses a release-candidate report that did not pass", () => {
  const root = copyReleaseFixture();
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(releaseCli, join(root, "scripts", "release.mjs"));
  const reportDirectory = join(root, "releases", releaseCandidateId, "reports");
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(join(reportDirectory, "release-candidate.json"), JSON.stringify({
    schemaVersion: 1,
    releaseId: releaseCandidateId,
    result: "failed",
  }));
  const output = join(root, "dist");

  const result = spawnSync(process.execPath, [join(root, "scripts", "release.mjs"), "bundle", output], {
    cwd: root,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /has not passed/);
  assert.equal(existsSync(output), false);
});

for (const {
  name,
  script,
  original,
  replacement,
  expectedError,
} of [
  {
    name: "bootstrap release ID",
    script: "bootstrap.sh",
    original: `release_id="${releaseCandidateId}"`,
    replacement: `release_id="${releaseCandidateId}-stale"`,
    expectedError: /Bootstrap release ID/,
  },
  {
    name: "binary installer release ID",
    script: "install-binary.sh",
    original: `release_id="${releaseCandidateId}"`,
    replacement: `release_id="${releaseCandidateId}-stale"`,
    expectedError: /Binary installer release ID/,
  },
  {
    name: "binary installer Pi version",
    script: "install-binary.sh",
    original: `pi_version="${releaseCandidateInput.upstream.packageVersion}"`,
    replacement: `pi_version="${releaseCandidateInput.upstream.packageVersion}-stale"`,
    expectedError: /Binary installer Pi version/,
  },
]) {
  test(`release verification rejects a mismatched ${name}`, () => {
    const root = copyReleaseFixture();
    const scriptPath = join(root, "scripts", script);
    const contents = readFileSync(scriptPath, "utf8");
    assert.equal(contents.includes(original), true);
    writeFileSync(scriptPath, contents.replace(original, replacement));

    const result = verify(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
  });
}

test("release verification rejects release documentation identity drift", () => {
  const root = copyReleaseFixture();
  const notes = join(root, "releases", releaseCandidateId, "RELEASE_NOTES.md");
  writeFileSync(notes, readFileSync(notes, "utf8").replace(`# Pi Wait for User · \`${releaseCandidateId}\``, "# stale release"));

  const result = verify(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Release notes heading/);
});

test("release verification rejects a changed patch", () => {
  const root = copyReleaseFixture();
  const patch = join(root, "patches", "active", "0001-feat-add-durable-single-tool-deferral.patch");
  writeFileSync(patch, "changed after release\n");

  const result = verify(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /0001-feat-add-durable-single-tool-deferral\.patch SHA-256/);
});
