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
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadReleaseCandidateInput } from "./lib/release-input.mjs";
import { createArchiveMetadata } from "./lib/release-metadata.mjs";

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binaryPlatforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"];
const binaryAssetNames = binaryPlatforms.map((platform) =>
  `pi-wait-for-user-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`,
);

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

function artifact(path, name = basename(path)) {
  return { name, sha256: sha256(path), size: statSync(path).size };
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${String(expected)}, found ${String(actual)}`);
}

function expectIncludes(actual, expected, label) {
  if (!actual.includes(expected)) fail(`${label}: missing ${expected}`);
}

function readShellVariable(path, variable, label) {
  const matches = [...readFileSync(path, "utf8").matchAll(new RegExp(`^${variable}="([^"]*)"$`, "gm"))];
  if (matches.length !== 1) fail(`${label}: expected exactly one ${variable} assignment, found ${matches.length}`);
  return matches[0][1];
}

function verifyRelease(root) {
  const { releaseId, manifest } = loadReleaseCandidateInput(root);
  expectEqual(manifest.schemaVersion, 1, "Release candidate input schema");
  expectEqual(manifest.releaseId, releaseId, "Package-derived release ID");
  expectEqual(manifest.tag, releaseId, "Release tag");
  expectEqual(JSON.stringify(manifest.binaryPlatforms), JSON.stringify(binaryPlatforms), "Binary platforms");

  const bootstrapPath = join(root, "scripts", "bootstrap.sh");
  const binaryInstallerPath = join(root, "scripts", "install-binary.sh");
  expectEqual(
    readShellVariable(bootstrapPath, "release_id", "Bootstrap release ID"),
    manifest.releaseId,
    "Bootstrap release ID",
  );
  expectEqual(
    readShellVariable(binaryInstallerPath, "release_id", "Binary installer release ID"),
    manifest.releaseId,
    "Binary installer release ID",
  );
  expectEqual(
    readShellVariable(binaryInstallerPath, "pi_version", "Binary installer Pi version"),
    manifest.upstream.packageVersion,
    "Binary installer Pi version",
  );

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

  if (!manifest.sessionCompatibility || !manifest.manager || !manifest.provenance) {
    fail("Release candidate input must declare session, Manager Release, and provenance compatibility");
  }

  const releaseNotes = readFileSync(join(root, "releases", releaseId, "RELEASE_NOTES.md"), "utf8");
  expectIncludes(releaseNotes, `# Pi Wait for User · \`${releaseId}\``, "Release notes heading");
  expectIncludes(releaseNotes, `/download/${releaseId}/install.sh`, "Release notes install identity");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  expectIncludes(readme, `The packaged release candidate is **\`${releaseId}\`**`, "README release candidate identity");
  expectIncludes(readme, `/download/${releaseId}/install.sh`, "README install identity");

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

function bundleRelease(root, outputArgument, binaryDirectoryArgument) {
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

  if (!binaryDirectoryArgument) fail("Binary assets are required for the release candidate");
  const binaryDirectory = resolve(binaryDirectoryArgument);
  for (const name of binaryAssetNames) {
    if (!existsSync(join(binaryDirectory, name))) fail(`Missing required binary asset: ${name}`);
  }

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

    const platformArchives = [];
    const packagedArchiveMetadata = new Map();
    for (const name of binaryAssetNames) {
      const source = join(binaryDirectory, name);
      const destination = join(temporary, name);
      copyFileSync(source, destination);
      const metadataPath = join(binaryDirectory, `${name}.metadata.json`);
      if (!existsSync(metadataPath)) fail(`Missing required binary metadata: ${name}.metadata.json`);
      const metadata = readJson(metadataPath);
      const descriptor = artifact(destination);
      const expectedPlatform = name.replace(/^pi-wait-for-user-/, "").replace(/\.(?:tar\.gz|zip)$/, "");
      if (
        metadata.schemaVersion !== 1 ||
        metadata.platform !== expectedPlatform ||
        metadata.artifact?.name !== descriptor.name ||
        metadata.artifact?.sha256 !== descriptor.sha256 ||
        metadata.artifact?.size !== descriptor.size ||
        !metadata.archiveMetadata ||
        !Array.isArray(metadata.payload) || metadata.payload.length === 0
      ) fail(`Binary metadata does not match archive: ${name}`);
      platformArchives.push({ platform: metadata.platform, artifact: descriptor, payload: metadata.payload });
      packagedArchiveMetadata.set(metadata.platform, metadata.archiveMetadata);
    }
    const installPath = join(temporary, "install.sh");
    const fixtureGateOutput = join(temporary, "fixture-gate.json");
    const candidateOutput = join(temporary, "release-candidate.json");
    const notesOutput = join(temporary, "RELEASE_NOTES.md");
    copyFileSync(join(root, "scripts", "bootstrap.sh"), installPath);
    copyFileSync(join(root, manifest.fixtureGate.path), fixtureGateOutput);
    copyFileSync(reportPath, candidateOutput);
    copyFileSync(join(root, "releases", manifest.releaseId, "RELEASE_NOTES.md"), notesOutput);

    const questionManifestPath = safePath(root, manifest.questionTool.manifestPath);
    const managerArtifacts = [artifact(releaseAsset)];
    const questionToolPackage = artifact(questionPackage);
    const bootstrap = { installer: artifact(installPath) };
    const releaseGates = [{
      name: "release-candidate",
      status: "passed",
      definition: artifact(fixtureGateOutput),
      report: artifact(candidateOutput),
    }];
    const releaseNotes = artifact(notesOutput);
    const provenanceArtifacts = [
      ...managerArtifacts,
      questionToolPackage,
      bootstrap.installer,
      ...platformArchives.map((entry) => entry.artifact),
      ...releaseGates.flatMap((entry) => [entry.definition, entry.report]),
      releaseNotes,
    ].sort((left, right) => left.name.localeCompare(right.name)).map(({ name, sha256: digest }) => ({ name, sha256: digest }));
    const sourceCommit = process.env.GITHUB_SHA ?? process.env.RELEASE_SOURCE_COMMIT;
    if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? "")) {
      fail("GITHUB_SHA or RELEASE_SOURCE_COMMIT must identify the exact release source commit");
    }
    const unsignedManifest = {
      schemaVersion: 1,
      type: "release-manifest",
      releaseId: manifest.releaseId,
      tag: manifest.tag,
      publishedAt: process.env.RELEASE_PUBLISHED_AT ?? new Date().toISOString(),
      upstream: manifest.upstream,
      patches: manifest.patches.map((patch, index) => ({
        order: index + 1,
        path: patch.path,
        sha256: patch.sha256,
        size: statSync(safePath(root, patch.path)).size,
      })),
      compatibility: {
        questionTool: {
          name: manifest.questionTool.name,
          version: manifest.questionTool.version,
          manifest: artifact(questionManifestPath, manifest.questionTool.manifestPath),
          package: questionToolPackage,
          coreProtocolVersions: manifest.questionTool.coreProtocolVersions,
          handlerId: manifest.questionTool.handlerId,
          handlerVersion: manifest.questionTool.handlerVersion,
          packageSchemaVersions: manifest.questionTool.packageSchemaVersions,
        },
        sessions: manifest.sessionCompatibility,
      },
      manager: {
        releaseId: manifest.manager.releaseId,
        compatibleReleaseManifestVersions: manifest.manager.compatibleReleaseManifestVersions,
        artifacts: managerArtifacts,
      },
      bootstrap,
      platformArchives,
      releaseGates,
      provenance: {
        repository: manifest.provenance.repository,
        workflow: manifest.provenance.workflow,
        sourceCommit,
        artifacts: provenanceArtifacts,
      },
      releaseNotes,
    };
    for (const archive of platformArchives) {
      createArchiveMetadata(unsignedManifest, archive.platform, {
        existing: packagedArchiveMetadata.get(archive.platform),
      });
    }
    const metadataDirectory = join(temporary, ".release-metadata");
    mkdirSync(metadataDirectory);
    writeFileSync(join(metadataDirectory, "unsigned-manifest.json"), `${JSON.stringify(unsignedManifest, null, 2)}\n`);
    writeFileSync(join(metadataDirectory, "provenance-request.json"), `${JSON.stringify(unsignedManifest.provenance, null, 2)}\n`);
    renameSync(temporary, output);
    console.log(`Built ${manifest.releaseId} release assets in ${output}.`);
    console.log(`Question Tool artifact: ${basename(questionPackage)}`);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function usage() {
  return "Usage: release.mjs <verify [release-root] | bundle <output-directory> <binary-directory>>";
}

try {
  const [command, argument, binaryDirectory, extra] = process.argv.slice(2);
  if (extra) fail(usage());
  if (command === "verify") {
    if (binaryDirectory) fail(usage());
    const root = resolve(argument ?? defaultRoot);
    const manifest = verifyRelease(root);
    console.log(
      `Verified ${manifest.releaseId}: Pi ${manifest.upstream.tag}, ${manifest.patches.length} patches, Question Tool ${manifest.questionTool.version}.`,
    );
  } else if (command === "bundle" && argument) {
    bundleRelease(defaultRoot, argument, binaryDirectory);
  } else {
    fail(usage());
  }
} catch (error) {
  console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
