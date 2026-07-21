import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createSource(root, version = "1.0.0") {
  const source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "Patch Workspace Test");
  git(source, "config", "user.email", "patch-workspace@example.test");
  writeFileSync(join(source, "package.json"), `${JSON.stringify({ name: "fixture-pi", version }, null, 2)}\n`);
  writeFileSync(join(source, "a.txt"), "original\n");
  writeFileSync(join(source, "b.txt"), "original\n");
  writeFileSync(
    join(source, "test.sh"),
    "#!/bin/sh\nif [ -n \"$TEST_HOME_LOG\" ]; then printf '%s' \"$HOME\" > \"$TEST_HOME_LOG\"; fi\n",
  );
  chmodSync(join(source, "test.sh"), 0o755);
  git(source, "add", "package.json", "a.txt", "b.txt", "test.sh");
  git(source, "commit", "-m", "Fixture release");
  git(source, "tag", "v1.0.0");
  git(source, "remote", "add", "origin", source);
  return source;
}

function createProject(root, source, expectedVersion = "1.0.0") {
  const project = join(root, "project");
  mkdirSync(join(project, "scripts"), { recursive: true });
  mkdirSync(join(project, "upstream"), { recursive: true });
  mkdirSync(join(project, "patches", "active"), { recursive: true });
  cpSync(join(repositoryRoot, "scripts", "pi-patch.mjs"), join(project, "scripts", "pi-patch.mjs"));
  writeFileSync(
    join(project, "upstream", "pi.lock.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: source,
        tag: "v1.0.0",
        commit: git(source, "rev-parse", "HEAD"),
        packages: [{ path: "package.json", name: "fixture-pi", version: expectedVersion }],
      },
      null,
      2,
    )}\n`,
  );
  return project;
}

function patch(from, to, file = "a.txt") {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
}

function run(project, ...args) {
  return spawnSync(process.execPath, [join(project, "scripts", "pi-patch.mjs"), ...args], {
    cwd: project,
    encoding: "utf8",
  });
}

test("apply rejects a package-version mismatch before changing source", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-patch-test-"));
  const source = createSource(root, "2.0.0");
  const project = createProject(root, source);
  writeFileSync(join(project, "patches", "active", "0001-change.patch"), patch("original", "patched"));

  const result = run(project, "apply", source);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture-pi.*expected 1\.0\.0.*found 2\.0\.0/);
  assert.equal(readFileSync(join(source, "a.txt"), "utf8"), "original\n");
  assert.equal(git(source, "status", "--porcelain"), "");
});

test("apply checks every patch before changing source", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-patch-test-"));
  const source = createSource(root);
  const project = createProject(root, source);
  writeFileSync(join(project, "patches", "active", "0001-valid.patch"), patch("original", "patched"));
  writeFileSync(join(project, "patches", "active", "0002-invalid.patch"), patch("missing", "patched", "b.txt"));

  const result = run(project, "apply", source);

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(source, "a.txt"), "utf8"), "original\n");
  assert.equal(readFileSync(join(source, "b.txt"), "utf8"), "original\n");
  assert.equal(git(source, "status", "--porcelain"), "");
});

test("apply installs the complete sorted patch set on an exact source", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-patch-test-"));
  const source = createSource(root);
  const project = createProject(root, source);
  writeFileSync(join(project, "patches", "active", "0002-second.patch"), patch("first", "second"));
  writeFileSync(join(project, "patches", "active", "0001-first.patch"), patch("original", "first"));

  const result = run(project, "apply", source);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(source, "a.txt"), "utf8"), "second\n");
});

test("prepare clones the pinned source and applies the active patches", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-patch-test-"));
  const source = createSource(root);
  const project = createProject(root, source);
  const destination = join(root, "prepared");
  writeFileSync(join(project, "patches", "active", "0001-change.patch"), patch("original", "prepared"));

  const result = run(project, "prepare", destination);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(destination, "a.txt"), "utf8"), "prepared\n");
  assert.equal(git(destination, "rev-parse", "HEAD"), git(source, "rev-parse", "HEAD"));
});

test("baseline verification rejects a mismatch before dependency installation", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-patch-test-"));
  const source = createSource(root, "2.0.0");
  const project = createProject(root, source);
  const fakeBin = join(root, "bin");
  const npmCalled = join(root, "npm-called");
  mkdirSync(fakeBin);
  cpSync(join(repositoryRoot, "scripts", "verify-upstream.mjs"), join(project, "scripts", "verify-upstream.mjs"));
  writeFileSync(join(fakeBin, "npm"), `#!/bin/sh\ntouch "${npmCalled}"\n`);
  chmodSync(join(fakeBin, "npm"), 0o755);

  const result = spawnSync(process.execPath, [join(project, "scripts", "verify-upstream.mjs"), source], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });

  assert.notEqual(result.status, 0);
  assert.equal(existsSync(npmCalled), false);
});

test("baseline verification isolates upstream tests from user configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-patch-test-"));
  const source = createSource(root);
  const project = createProject(root, source);
  const fakeBin = join(root, "bin");
  const homeLog = join(root, "test-home");
  mkdirSync(fakeBin);
  mkdirSync(join(project, "prototype", "session-journal-harness"), { recursive: true });
  cpSync(join(repositoryRoot, "scripts", "verify-upstream.mjs"), join(project, "scripts", "verify-upstream.mjs"));
  writeFileSync(join(fakeBin, "npm"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(fakeBin, "npm"), 0o755);
  writeFileSync(join(project, "prototype", "session-journal-harness", "run.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(project, "prototype", "session-journal-harness", "run.sh"), 0o755);

  const result = spawnSync(process.execPath, [join(project, "scripts", "verify-upstream.mjs"), source], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      TEST_HOME_LOG: homeLog,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(readFileSync(homeLog, "utf8"), process.env.HOME);
});
