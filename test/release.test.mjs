import assert from "node:assert/strict";
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

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseCli = join(repositoryRoot, "scripts", "release.mjs");
const releaseGateCli = join(repositoryRoot, "scripts", "release-gate.mjs");
const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function copyReleaseFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-release-test-"));
  temporaryRoots.push(root);
  for (const path of ["releases", "upstream", "patches", "packages/question-tool/package.json"]) {
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
    "scripts/package-binaries.mjs",
    "scripts/pi-patch.mjs",
    "scripts/release.mjs",
    "upstream",
  ]) {
    cpSync(join(repositoryRoot, path), join(root, path), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(join(root, "releases", "pi-v0.81.1-patch.2", "manifest.json"), "utf8"));
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

test("the active release manifest verifies every pinned input", () => {
  const result = verify(repositoryRoot);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified pi-v0\.81\.1-patch\.2: Pi v0\.81\.1, 10 patches, Question Tool 0\.1\.1/);
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

test("a passing release builds checksummed patch, binary, and Question Tool downloads", () => {
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
    writeFileSync(join(binaries, name), `fixture ${name}\n`);
  }

  const result = spawnSync(process.execPath, [join(root, "scripts", "release.mjs"), "bundle", output, binaries], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const files = readdirSync(output);
  assert.ok(files.includes("pi-wait-for-user-pi-v0.81.1-patch.2.tgz"));
  assert.ok(files.includes("taylorrowser-pi-question-tool-0.1.1.tgz"));
  assert.ok(files.includes("install.sh"));
  assert.ok(files.includes("pi-wait-for-user-darwin-arm64.tar.gz"));
  assert.ok(files.includes("pi-wait-for-user-linux-x64.tar.gz"));
  const sums = readFileSync(join(output, "SHA256SUMS"), "utf8");
  assert.match(sums, /pi-wait-for-user-pi-v0\.81\.1-patch\.2\.tgz/);
  assert.match(sums, /taylorrowser-pi-question-tool-0\.1\.1\.tgz/);
});

test("bundling refuses an incomplete required gate even if marked passed", () => {
  const root = copyReleaseFixture();
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(releaseCli, join(root, "scripts", "release.mjs"));
  const manifest = JSON.parse(readFileSync(join(root, "releases", "pi-v0.81.1-patch.2", "manifest.json"), "utf8"));
  const gate = JSON.parse(readFileSync(join(root, manifest.fixtureGate.path), "utf8"));
  const reportDirectory = join(root, "releases", "pi-v0.81.1-patch.2", "reports");
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
  const reportDirectory = join(root, "releases", "pi-v0.81.1-patch.2", "reports");
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(join(reportDirectory, "release-candidate.json"), JSON.stringify({
    schemaVersion: 1,
    releaseId: "pi-v0.81.1-patch.2",
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

test("release verification rejects a changed patch", () => {
  const root = copyReleaseFixture();
  const patch = join(root, "patches", "active", "0001-feat-add-durable-single-tool-deferral.patch");
  writeFileSync(patch, "changed after release\n");

  const result = verify(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /0001-feat-add-durable-single-tool-deferral\.patch SHA-256/);
});
