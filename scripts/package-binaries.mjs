#!/usr/bin/env node

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadReleaseCandidateInput } from "./lib/release-input.mjs";
import { createPayloadInventory, sha256File } from "./lib/release-metadata.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const supportedPlatforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
  "windows-arm64",
];

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${basename(command)} failed: ${(result.stderr || result.stdout).trim()}`);
}

function parseArguments(args) {
  let input;
  let output;
  let platforms = supportedPlatforms;
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (!value) fail(usage());
    if (flag === "--input") input = resolve(value);
    else if (flag === "--output") output = resolve(value);
    else if (flag === "--platform" && supportedPlatforms.includes(value)) platforms = [value];
    else fail(usage());
  }
  if (!input || !output) fail(usage());
  return { input, output, platforms };
}

function usage() {
  return "Usage: package-binaries.mjs --input <upstream-binaries> --output <directory> [--platform <platform>]";
}

function unixPlatformCheck(platform) {
  const allowed = {
    "darwin-arm64": "Darwin-arm64",
    "darwin-x64": "Darwin-x86_64",
    "linux-arm64": "Linux-aarch64|Linux-arm64",
    "linux-x64": "Linux-x86_64",
  }[platform];
  return `case "$(uname -s)-$(uname -m)" in ${allowed}) ;; *) echo "pi-wait-for-user: binary platform mismatch" >&2; exit 1;; esac`;
}

function unixLauncher(releaseId, platform) {
  return `#!/bin/sh
set -eu
script=$0
if [ -L "$script" ]; then
  target=$(readlink "$script")
  case "$target" in
    /*) script=$target ;;
    *) script=$(dirname "$script")/$target ;;
  esac
fi
directory=$(CDPATH= cd -- "$(dirname -- "$script")" && pwd)
${unixPlatformCheck(platform)}
grep -q '"releaseId": "${releaseId}"' "$directory/release.json" || { echo "pi-wait-for-user: release identity mismatch" >&2; exit 1; }
grep -q '"platform": "${platform}"' "$directory/release.json" || { echo "pi-wait-for-user: binary platform mismatch" >&2; exit 1; }
test -f "$directory/question-tool/extensions/question-tool.ts" || { echo "pi-wait-for-user: Question Tool is missing" >&2; exit 1; }
if [ "\${1:-}" = "conformance" ]; then
  exec "$directory/pi-core" "$@"
fi
exec "$directory/pi-core" -e "$directory/question-tool" "$@"
`;
}

function windowsLauncher(releaseId, platform) {
  const architecture = platform.endsWith("-arm64") ? "ARM64" : "AMD64";
  return `@echo off\r\nset DIR=%~dp0\r\nif /I not "%PROCESSOR_ARCHITECTURE%"=="${architecture}" (echo pi-wait-for-user: binary platform mismatch 1>&2 & exit /b 1)\r\nfindstr /C:"\\"releaseId\\": \\"${releaseId}\\"" "%DIR%release.json" >nul || (echo pi-wait-for-user: release identity mismatch 1>&2 & exit /b 1)\r\nfindstr /C:"\\"platform\\": \\"${platform}\\"" "%DIR%release.json" >nul || (echo pi-wait-for-user: binary platform mismatch 1>&2 & exit /b 1)\r\nif not exist "%DIR%question-tool\\extensions\\question-tool.ts" (echo pi-wait-for-user: Question Tool is missing 1>&2 & exit /b 1)\r\nif "%~1"=="conformance" (\r\n  "%DIR%pi-core.exe" %*\r\n) else (\r\n  "%DIR%pi-core.exe" -e "%DIR%question-tool" %*\r\n)\r\n`;
}

function packagePlatform(input, output, platform, release, question) {
  const source = join(input, platform);
  if (!existsSync(source)) fail(`Missing upstream binary directory: ${source}`);
  const temporaryRoot = mkdtempSync(join(tmpdir(), `pi-binary-${platform}-`));
  const payload = join(temporaryRoot, "pi-wait-for-user");
  try {
    cpSync(source, payload, { recursive: true });
    const windows = platform.startsWith("windows-");
    const originalBinary = join(payload, windows ? "pi.exe" : "pi");
    const coreBinary = join(payload, windows ? "pi-core.exe" : "pi-core");
    if (!existsSync(originalBinary)) fail(`Missing Pi binary for ${platform}`);
    renameSync(originalBinary, coreBinary);

    cpSync(join(projectRoot, "packages", "question-tool"), join(payload, "question-tool"), {
      recursive: true,
      filter: (path) => !path.includes(`${join("question-tool", "test")}`),
    });
    cpSync(join(projectRoot, "scripts", "install-binary.sh"), join(payload, "install.sh"));
    const archiveMetadata = {
      schemaVersion: 1,
      releaseId: release.releaseId,
      upstream: release.upstream,
      platform,
      questionTool: { name: question.name, version: question.version },
    };
    writeFileSync(join(payload, "release.json"), `${JSON.stringify(archiveMetadata, null, 2)}\n`);

    if (windows) {
      writeFileSync(join(payload, "pi-wait-for-user.cmd"), windowsLauncher(release.releaseId, platform));
    } else {
      writeFileSync(join(payload, "pi-wait-for-user"), unixLauncher(release.releaseId, platform));
      chmodSync(join(payload, "pi-wait-for-user"), 0o755);
      chmodSync(join(payload, "pi-core"), 0o755);
      chmodSync(join(payload, "install.sh"), 0o755);
    }

    const inventory = createPayloadInventory(temporaryRoot);
    mkdirSync(output, { recursive: true });
    const assetName = `pi-wait-for-user-${platform}.${windows ? "zip" : "tar.gz"}`;
    const assetPath = join(output, assetName);
    if (windows) {
      run("zip", ["-qr", assetPath, "pi-wait-for-user"], temporaryRoot);
    } else {
      run("tar", ["-czf", assetPath, "pi-wait-for-user"], temporaryRoot);
    }
    const stat = lstatSync(assetPath);
    writeFileSync(join(output, `${assetName}.metadata.json`), `${JSON.stringify({
      schemaVersion: 1,
      platform,
      artifact: { name: assetName, sha256: sha256File(assetPath), size: stat.size },
      archiveMetadata,
      payload: inventory,
    }, null, 2)}\n`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const { manifest: release } = loadReleaseCandidateInput(projectRoot);
  const question = JSON.parse(readFileSync(join(projectRoot, "packages", "question-tool", "package.json"), "utf8"));
  if (release.questionTool.version !== question.version) fail("Question Tool version does not match the release candidate input");
  if (existsSync(options.output)) fail(`Output already exists: ${options.output}`);
  for (const platform of options.platforms) packagePlatform(options.input, options.output, platform, release, question);
  console.log(`Packaged ${options.platforms.length} binary release${options.platforms.length === 1 ? "" : "s"}.`);
} catch (error) {
  console.error(`package-binaries: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
