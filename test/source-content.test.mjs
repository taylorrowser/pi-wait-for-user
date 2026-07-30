import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const piBaseCommit = "20be4b18d4c57487f8993d2762bace129f0cf7c6";

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).trim().split("\n");
}

test("the default branch is a Patch and Question Tool source without lifecycle machinery", () => {
  const files = trackedFiles();
  const retiredRoots = ["manager", "manager.mjs", "releases/", "scripts/", "upstream/", "prototype/", "research/"];
  for (const retired of retiredRoots) {
    assert.equal(files.some((path) => path === retired || path.startsWith(retired)), false, `retired default-branch path remains: ${retired}`);
  }

  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.match(readme, /PorcuPi v0\.1\.0/);
  assert.match(readme, /pi managed uninstall/);
  assert.match(readme, /historical tags.*GitHub Releases/is);
  assert.doesNotMatch(readme, /^## (Managed lifecycle|Update an existing installation|Maintainer workflow)/m);
});

test("narrow PorcuPi metadata covers every regular active Patch at the exact Pi Base", () => {
  const metadata = readJson("porcupi.json");
  assert.deepEqual(Object.keys(metadata).sort(), ["patches", "schemaVersion"]);
  assert.equal(metadata.schemaVersion, 1);

  const patchNames = readdirSync(join(root, "patches", "active"))
    .filter((name) => name.endsWith(".patch"))
    .sort();
  const patchPaths = patchNames.map((name) => `patches/active/${name}`);
  assert.equal(patchPaths.length, 20);
  assert.deepEqual(metadata.patches.map((patch) => patch.path), patchPaths);

  for (const patch of metadata.patches) {
    assert.deepEqual(Object.keys(patch).sort(), [
      "displayName", "path", "supportedPiBaseCommits", "supportedPiBaseVersions",
    ]);
    assert.match(patch.displayName, /\S/);
    assert.deepEqual(patch.supportedPiBaseVersions, ["v0.81.1"]);
    assert.deepEqual(patch.supportedPiBaseCommits, [piBaseCommit]);

    const absolute = join(root, patch.path);
    const stat = lstatSync(absolute);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    const parsed = spawnSync("git", ["apply", "--numstat", patch.path], { cwd: root, encoding: "utf8" });
    assert.equal(parsed.status, 0, `${patch.path}: ${parsed.stderr}`);
    assert.match(parsed.stdout, /\S/);
  }
});

test("the Question Tool remains an independently versioned ordinary Pi package", () => {
  const manifest = readJson("packages/question-tool/package.json");
  assert.equal(manifest.name, "@taylorrowser/pi-question-tool");
  assert.equal(manifest.version, "0.1.5");
  assert.deepEqual(manifest.pi, { extensions: ["./extensions/question-tool.ts"] });
  assert.deepEqual(manifest.piWaitForUser, {
    upstreamPiVersion: "0.81.1",
    coreProtocolVersions: [1],
    handlerId: "dev.taylorrowser.pi-question-tool.question",
    handlerVersion: 1,
    resumableHandlerVersions: [1],
    packageSchemaVersions: [1],
  });
  assert.equal("dependencies" in manifest, false);

  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: join(root, "packages", "question-tool"),
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map((file) => file.path);
  assert.ok(files.includes("extensions/question-tool.ts"));
  assert.ok(files.includes("src/index.ts"));
  assert.ok(files.includes("README.md"));
  assert.ok(files.every((path) => !path.startsWith("patches/") && !path.startsWith("test/")));
});
