#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lockPath = join(projectRoot, "upstream", "pi.lock.json");
const patchDirectory = join(projectRoot, "patches", "active");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture === false ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout?.trim() ?? "";
}

function readLock() {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lock.schemaVersion !== 1) throw new Error(`Unsupported lock schema: ${String(lock.schemaVersion)}`);
  if (typeof lock.repository !== "string" || typeof lock.tag !== "string") {
    throw new Error("Lock must declare repository and tag strings");
  }
  if (typeof lock.commit !== "string" || !/^[0-9a-f]{40}$/.test(lock.commit)) {
    throw new Error("Lock must declare a full 40-character commit SHA");
  }
  if (!Array.isArray(lock.packages) || lock.packages.length === 0) {
    throw new Error("Lock must declare at least one package identity");
  }
  return lock;
}

function verifySource(source, lock) {
  const head = run("git", ["rev-parse", "HEAD"], { cwd: source });
  if (head !== lock.commit) throw new Error(`Source commit: expected ${lock.commit}, found ${head}`);

  const tagCommit = run("git", ["rev-parse", `${lock.tag}^{commit}`], { cwd: source });
  if (tagCommit !== lock.commit) {
    throw new Error(`Source tag ${lock.tag}: expected ${lock.commit}, found ${tagCommit}`);
  }

  const repository = run("git", ["remote", "get-url", "origin"], { cwd: source });
  if (repository !== lock.repository) {
    throw new Error(`Source repository: expected ${lock.repository}, found ${repository}`);
  }

  for (const expected of lock.packages) {
    const manifestPath = join(source, expected.path);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name !== expected.name) {
      throw new Error(`${expected.path}: expected package ${expected.name}, found ${String(manifest.name)}`);
    }
    if (manifest.version !== expected.version) {
      throw new Error(`${expected.name}: expected ${expected.version}, found ${String(manifest.version)}`);
    }
  }

  const status = run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: source });
  if (status) throw new Error(`Source has tracked changes and is not safe to patch:\n${status}`);
}

function patchFiles() {
  if (!existsSync(patchDirectory)) return [];
  return readdirSync(patchDirectory)
    .filter((name) => name.endsWith(".patch"))
    .sort()
    .map((name) => join(patchDirectory, name));
}

function preflightPatches(source, patches, commit) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-patch-preflight-"));
  const checkout = join(temporaryRoot, "source");
  try {
    run("git", ["clone", "--shared", "--no-checkout", source, checkout]);
    run("git", ["checkout", "--detach", commit], { cwd: checkout });
    for (const patch of patches) {
      run("git", ["apply", "--check", "--whitespace=error-all", patch], { cwd: checkout });
      run("git", ["apply", "--whitespace=error-all", patch], { cwd: checkout });
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function applyPatches(source, lock) {
  verifySource(source, lock);
  const patches = patchFiles();
  if (patches.length === 0) {
    console.log(`Verified ${lock.tag} (${lock.commit}); no active patches.`);
    return;
  }

  preflightPatches(source, patches, lock.commit);
  for (const patch of patches) run("git", ["apply", "--whitespace=error-all", patch], { cwd: source });
  console.log(`Applied ${patches.length} patch${patches.length === 1 ? "" : "es"} to ${lock.tag}.`);
}

function prepare(destination, lock) {
  if (existsSync(destination)) throw new Error(`Destination already exists: ${destination}`);
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const temporary = join(parent, `.${basename(destination)}.tmp-${randomUUID()}`);

  try {
    run("git", ["clone", "--branch", lock.tag, "--single-branch", lock.repository, temporary], {
      capture: false,
    });
    applyPatches(temporary, lock);
    renameSync(temporary, destination);
    console.log(`Prepared downstream workspace at ${destination}.`);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function usage() {
  return "Usage: pi-patch.mjs <verify|apply|prepare> <source-or-destination>";
}

try {
  const [command, pathArgument] = process.argv.slice(2);
  if (!command || !pathArgument || process.argv.length !== 4) throw new Error(usage());
  const path = resolve(pathArgument);
  const lock = readLock();

  if (command === "verify") {
    verifySource(path, lock);
    console.log(`Verified ${lock.tag} (${lock.commit}).`);
  } else if (command === "apply") {
    applyPatches(path, lock);
  } else if (command === "prepare") {
    prepare(path, lock);
  } else {
    throw new Error(usage());
  }
} catch (error) {
  console.error(`pi-patch: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
