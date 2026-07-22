import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function createInstallation() {
  const root = mkdtempSync(join(tmpdir(), "pi-release-install-"));
  temporaryRoots.push(root);
  const source = join(root, "pi");
  const question = join(root, "question-tool");
  const cli = join(source, "packages", "coding-agent", "dist", "cli.js");
  mkdirSync(join(source, "packages", "coding-agent", "dist"), { recursive: true });
  mkdirSync(question);
  writeFileSync(join(source, "packages", "coding-agent", "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    version: "0.81.1",
  }));
  writeFileSync(join(question, "package.json"), JSON.stringify({
    name: "@taylorrowser/pi-question-tool",
    version: "0.1.0",
    piWaitForUser: {
      upstreamPiVersion: "0.81.1",
      coreProtocolVersions: [1],
      handlerId: "dev.taylorrowser.pi-question-tool.question",
      handlerVersion: 1,
    },
  }));
  writeFileSync(cli, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.PI_LAUNCH_LOG, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(cli, 0o755);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: source });
  execFileSync("git", ["config", "user.name", "Release Test"], { cwd: source });
  execFileSync("git", ["config", "user.email", "release@example.test"], { cwd: source });
  execFileSync("git", ["add", "."], { cwd: source });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: source });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
  execFileSync("git", ["tag", "v0.81.1"], { cwd: source });
  execFileSync("git", ["remote", "add", "origin", source], { cwd: source });
  writeFileSync(join(root, "receipt.json"), `${JSON.stringify({
    schemaVersion: 1,
    releaseId: "pi-v0.81.1-patch.1",
    upstreamRepository: source,
    upstreamTag: "v0.81.1",
    upstreamCommit: commit,
    upstreamPackageVersion: "0.81.1",
    questionTool: {
      name: "@taylorrowser/pi-question-tool",
      version: "0.1.0",
      coreProtocolVersions: [1],
      handlerId: "dev.taylorrowser.pi-question-tool.question",
      handlerVersion: 1,
    },
  }, null, 2)}\n`);
  return { root, commit };
}

test("installation cannot start without a passing release-candidate report", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-release-preflight-"));
  temporaryRoots.push(root);
  const project = join(root, "release");
  mkdirSync(join(project, "scripts"), { recursive: true });
  cpSync(join(repositoryRoot, "scripts", "install.mjs"), join(project, "scripts", "install.mjs"));
  cpSync(join(repositoryRoot, "releases"), join(project, "releases"), { recursive: true });
  rmSync(join(project, "releases", "pi-v0.81.1-patch.4", "reports"), { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [join(project, "scripts", "install.mjs"), "install", "--install-dir", join(root, "install"), "--bin-dir", join(root, "bin")],
    { cwd: project, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /passing release-candidate report/);
  assert.equal(existsSync(join(root, "install")), false);
});

test("the release launcher verifies its exact Pi identity before startup", () => {
  const installation = createInstallation();
  const receipt = JSON.parse(readFileSync(join(installation.root, "receipt.json"), "utf8"));
  receipt.upstreamCommit = "0".repeat(40);
  writeFileSync(join(installation.root, "receipt.json"), JSON.stringify(receipt));
  const log = join(installation.root, "launched");

  const result = spawnSync(process.execPath, [join(import.meta.dirname, "..", "scripts", "launch.mjs"), installation.root, "--"], {
    encoding: "utf8",
    env: { ...process.env, PI_LAUNCH_LOG: log },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected 0000000000000000000000000000000000000000/);
  assert.equal(existsSync(log), false);
});

test("the release launcher loads the bundled Question Tool and forwards user arguments", () => {
  const installation = createInstallation();
  const log = join(installation.root, "launched");

  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "..", "scripts", "launch.mjs"), installation.root, "--", "--version"],
    { encoding: "utf8", env: { ...process.env, PI_LAUNCH_LOG: log } },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), ["-e", join(installation.root, "question-tool"), "--version"]);
});
