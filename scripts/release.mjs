#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  throw new Error(message);
}

function safePath(root, path) {
  if (typeof path !== "string" || path.length === 0) fail("Manifest file paths must be non-empty strings");
  const absolute = resolve(root, path);
  const inside = relative(root, absolute);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`)) {
    fail(`Manifest path escapes the release root: ${path}`);
  }
  return absolute;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${String(expected)}, found ${String(actual)}`);
}

function verifyRelease(root) {
  const activePath = join(root, "releases", "active.json");
  const active = readJson(activePath);
  expectEqual(active.schemaVersion, 1, "Active release schema");
  if (typeof active.releaseId !== "string" || !/^[a-z0-9][a-z0-9.-]+$/.test(active.releaseId)) {
    fail("Active release ID must be a lowercase, filename-safe string");
  }

  const manifestPath = join(root, "releases", active.releaseId, "manifest.json");
  const manifest = readJson(manifestPath);
  expectEqual(manifest.schemaVersion, 1, "Release manifest schema");
  expectEqual(manifest.releaseId, active.releaseId, "Active release ID");
  expectEqual(manifest.tag, active.releaseId, "Release tag");

  const lock = readJson(join(root, "upstream", "pi.lock.json"));
  expectEqual(lock.repository, manifest.upstream.repository, "Upstream repository");
  expectEqual(lock.tag, manifest.upstream.tag, "Upstream tag");
  expectEqual(lock.commit, manifest.upstream.commit, "Upstream commit");
  for (const pkg of lock.packages ?? []) {
    expectEqual(pkg.version, manifest.upstream.packageVersion, `${pkg.name} version`);
  }

  if (!Array.isArray(manifest.patches) || manifest.patches.length === 0) fail("Release has no patches");
  const actualPatchPaths = readdirSync(join(root, "patches", "active"))
    .filter((name) => name.endsWith(".patch"))
    .sort()
    .map((name) => `patches/active/${name}`);
  const declaredPatchPaths = manifest.patches.map((patch) => patch.path);
  expectEqual(JSON.stringify(declaredPatchPaths), JSON.stringify(actualPatchPaths), "Ordered patch set");
  for (const patch of manifest.patches) {
    const path = safePath(root, patch.path);
    expectEqual(sha256(path), patch.sha256, `${patch.path} SHA-256`);
  }

  const fixtureGatePath = safePath(root, manifest.fixtureGate.path);
  expectEqual(sha256(fixtureGatePath), manifest.fixtureGate.sha256, "Fixture gate SHA-256");

  const questionManifestPath = safePath(root, manifest.questionTool.manifestPath);
  expectEqual(sha256(questionManifestPath), manifest.questionTool.manifestSha256, "Question Tool manifest SHA-256");
  const question = readJson(questionManifestPath);
  expectEqual(question.name, manifest.questionTool.name, "Question Tool package name");
  expectEqual(question.version, manifest.questionTool.version, "Question Tool package version");
  expectEqual(question.piWaitForUser?.upstreamPiVersion, manifest.upstream.packageVersion, "Question Tool Pi version");
  expectEqual(
    JSON.stringify(question.piWaitForUser?.coreProtocolVersions),
    JSON.stringify(manifest.questionTool.coreProtocolVersions),
    "Question Tool protocol versions",
  );
  expectEqual(question.piWaitForUser?.handlerId, manifest.questionTool.handlerId, "Question Tool handler ID");
  expectEqual(question.piWaitForUser?.handlerVersion, manifest.questionTool.handlerVersion, "Question Tool handler version");
  expectEqual(
    JSON.stringify(question.piWaitForUser?.packageSchemaVersions),
    JSON.stringify(manifest.questionTool.packageSchemaVersions),
    "Question Tool package schema versions",
  );

  return manifest;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${basename(command)} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function pack(root, packageRoot, output) {
  const raw = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], packageRoot);
  const result = JSON.parse(raw)[0];
  if (!result?.filename) fail(`npm pack did not report an artifact for ${packageRoot}`);
  return join(output, result.filename);
}

function bundleRelease(root, outputArgument) {
  const manifest = verifyRelease(root);
  const reportPath = join(root, "releases", manifest.releaseId, "reports", "release-candidate.json");
  if (!existsSync(reportPath)) fail(`Release candidate ${manifest.releaseId} has not passed`);
  const report = readJson(reportPath);
  if (report.releaseId !== manifest.releaseId || report.result !== "passed") {
    fail(`Release candidate ${manifest.releaseId} has not passed`);
  }
  const gate = readJson(join(root, manifest.fixtureGate.path));
  expectEqual(JSON.stringify(report.upstream), JSON.stringify(manifest.upstream), "Release report upstream identity");
  const reportedStages = (report.stages ?? []).map((stage) => stage.name);
  expectEqual(JSON.stringify(reportedStages), JSON.stringify(gate.requiredStages), "Release report stages");
  if (report.stages.some((stage) => stage.status !== "passed")) fail("Release report contains a failed required stage");
  const conformance = report.stages.find((stage) => stage.name === "public-conformance")?.result;
  if (!conformance || conformance.passed !== conformance.required || conformance.required < 1) {
    fail("Release report has no complete public conformance result");
  }
  const reportedCategories = (report.fixtureCategories ?? []).map((category) => category.name);
  const requiredCategories = gate.categories.map((category) => category.name);
  expectEqual(JSON.stringify(reportedCategories), JSON.stringify(requiredCategories), "Release report fixture categories");

  const output = resolve(outputArgument);
  if (existsSync(output)) fail(`Bundle output already exists: ${output}`);
  mkdirSync(dirname(output), { recursive: true });
  const temporary = join(dirname(output), `.${basename(output)}.tmp-${randomUUID()}`);
  mkdirSync(temporary);
  try {
    const releasePackage = pack(root, root, temporary);
    const questionPackage = pack(root, join(root, "packages", "question-tool"), temporary);
    const releaseAsset = join(temporary, `pi-wait-for-user-${manifest.releaseId}.tgz`);
    renameSync(releasePackage, releaseAsset);

    copyFileSync(join(root, "scripts", "bootstrap.sh"), join(temporary, "install.sh"));
    copyFileSync(join(root, "releases", manifest.releaseId, "manifest.json"), join(temporary, "release-manifest.json"));
    copyFileSync(join(root, manifest.fixtureGate.path), join(temporary, "fixture-gate.json"));
    copyFileSync(reportPath, join(temporary, "release-candidate.json"));

    const assets = readdirSync(temporary).sort().map((name) => ({ name, sha256: sha256(join(temporary, name)) }));
    writeFileSync(
      join(temporary, "artifact-manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, releaseId: manifest.releaseId, assets }, null, 2)}\n`,
    );
    const checksummed = readdirSync(temporary).sort();
    writeFileSync(
      join(temporary, "SHA256SUMS"),
      `${checksummed.map((name) => `${sha256(join(temporary, name))}  ${name}`).join("\n")}\n`,
    );
    renameSync(temporary, output);
    console.log(`Built ${manifest.releaseId} release assets in ${output}.`);
    console.log(`Question Tool artifact: ${basename(questionPackage)}`);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function usage() {
  return "Usage: release.mjs <verify [release-root] | bundle <output-directory>>";
}

try {
  const [command, argument, extra] = process.argv.slice(2);
  if (extra) fail(usage());
  if (command === "verify") {
    const root = resolve(argument ?? defaultRoot);
    const manifest = verifyRelease(root);
    console.log(
      `Verified ${manifest.releaseId}: Pi ${manifest.upstream.tag}, ${manifest.patches.length} patches, Question Tool ${manifest.questionTool.version}.`,
    );
  } else if (command === "bundle" && argument) {
    bundleRelease(defaultRoot, argument);
  } else {
    fail(usage());
  }
} catch (error) {
  console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
