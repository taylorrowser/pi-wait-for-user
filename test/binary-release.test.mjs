import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { verifyReleasePayloads } from "../scripts/lib/release-metadata.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedQuestionVersion = JSON.parse(
  readFileSync(join(repositoryRoot, "packages", "question-tool", "package.json"), "utf8"),
).version;
const nativePlatform = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function createPackagedBinary(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  const input = join(root, "input");
  const output = join(root, "output");
  const platform = join(input, nativePlatform);
  mkdirSync(platform, { recursive: true });
  writeFileSync(
    join(platform, "pi"),
    "#!/bin/sh\nif [ -n \"${PI_BINARY_ARGUMENT_LOG:-}\" ]; then printf '%s\\n' \"$@\" > \"$PI_BINARY_ARGUMENT_LOG\"; fi\ncase \" $* \" in *' --version '*) echo 0.81.1;; esac\nif [ \"${1:-}\" = conformance ]; then echo 'Deferred conformance passed (8/8)'; fi\n",
  );
  chmodSync(join(platform, "pi"), 0o755);
  execFileSync(process.execPath, [
    join(repositoryRoot, "scripts", "package-binaries.mjs"),
    "--input", input,
    "--output", output,
    "--platform", nativePlatform,
  ], { cwd: repositoryRoot });
  const assetName = `pi-wait-for-user-${nativePlatform}.tar.gz`;
  const asset = join(output, assetName);
  const extracted = join(root, "extracted");
  mkdirSync(extracted);
  execFileSync("tar", ["-xzf", asset, "-C", extracted]);
  const metadata = JSON.parse(readFileSync(join(output, `${assetName}.metadata.json`), "utf8"));
  verifyReleasePayloads(extracted, metadata.payload);
  return { root, output, assetName, asset, installation: join(extracted, "pi-wait-for-user") };
}

test("the recommended bootstrap selects a platform binary without Git, npm, or Node", () => {
  const bootstrap = readFileSync(join(repositoryRoot, "scripts", "bootstrap.sh"), "utf8");

  assert.doesNotMatch(bootstrap, /for command in node npm git/);
  assert.match(bootstrap, /pi-wait-for-user-\$\{platform\}\.tar\.gz/);
  assert.match(bootstrap, /uname -s/);
  assert.match(bootstrap, /uname -m/);
});

test("the bootstrap verifies its downloaded platform archive before installation", () => {
  const fixture = createPackagedBinary("pi-binary-bootstrap-");
  const digest = createHash("sha256").update(readFileSync(fixture.asset)).digest("hex");
  writeFileSync(join(fixture.output, "SHA256SUMS"), `${digest}  ${fixture.assetName}\n`);

  const fakeBin = join(fixture.root, "bin");
  mkdirSync(fakeBin);
  const curl = join(fakeBin, "curl");
  writeFileSync(curl, "#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ \"$1\" = -o ]; then output=$2; shift 2; else url=$1; shift; fi; done\ncp \"$PI_FIXTURE_DOWNLOADS/${url##*/}\" \"$output\"\n");
  chmodSync(curl, 0o755);
  const installDirectory = join(fixture.root, "installed");
  const binDirectory = join(fixture.root, "user-bin");
  const environment = {
    ...process.env,
    HOME: join(fixture.root, "home"),
    PATH: `${fakeBin}:${process.env.PATH}`,
    PI_FIXTURE_DOWNLOADS: fixture.output,
    PI_WAIT_FOR_USER_PLATFORM: nativePlatform,
  };
  const installed = spawnSync(
    "sh",
    [
      join(repositoryRoot, "scripts", "bootstrap.sh"),
      "install",
      "--install-dir", installDirectory,
      "--bin-dir", binDirectory,
    ],
    { encoding: "utf8", env: environment },
  );
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(existsSync(join(installDirectory, "pi-core")), true);

  writeFileSync(fixture.asset, "tampered after checksums\n");
  const rejected = spawnSync(
    "sh",
    [
      join(repositoryRoot, "scripts", "bootstrap.sh"),
      "install",
      "--install-dir", join(fixture.root, "rejected"),
      "--bin-dir", join(fixture.root, "rejected-bin"),
    ],
    { encoding: "utf8", env: environment },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /checksum mismatch/);
  assert.equal(existsSync(join(fixture.root, "rejected")), false);
});

test("a binary release loads the clearly named Question Tool without a source checkout", () => {
  const fixture = createPackagedBinary("pi-binary-release-");
  const log = join(fixture.root, "arguments");
  const launched = spawnSync(join(fixture.installation, "pi-wait-for-user"), ["--version"], {
    encoding: "utf8",
    env: { ...process.env, PI_BINARY_ARGUMENT_LOG: log },
  });

  assert.equal(launched.status, 0, launched.stderr);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    "-e",
    join(fixture.installation, "question-tool"),
    "--version",
  ]);
  const questionManifest = readFileSync(join(fixture.installation, "question-tool", "package.json"), "utf8");
  assert.equal(JSON.parse(questionManifest).version, expectedQuestionVersion);
  assert.match(questionManifest, /\.\/extensions\/question-tool\.ts/);

  writeFileSync(join(fixture.installation, "release.json"), "{}\n");
  rmSync(log);
  const mismatched = spawnSync(join(fixture.installation, "pi-wait-for-user"), ["--version"], {
    encoding: "utf8",
    env: { ...process.env, PI_BINARY_ARGUMENT_LOG: log },
  });
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /release identity mismatch/);
  assert.equal(existsSync(log), false);
});

test("binary installation does not invoke Git, npm, or a local build", () => {
  const fixture = createPackagedBinary("pi-binary-install-");
  const forbidden = join(fixture.root, "forbidden-command");
  const fakeBin = join(fixture.root, "bin");
  mkdirSync(fakeBin);
  for (const command of ["git", "npm"]) {
    const path = join(fakeBin, command);
    writeFileSync(path, `#!/bin/sh\ntouch "${forbidden}"\nexit 99\n`);
    chmodSync(path, 0o755);
  }
  const installDirectory = join(fixture.root, "installed");
  const binDirectory = join(fixture.root, "user-bin");
  const argumentLog = join(fixture.root, "arguments");
  const result = spawnSync(
    "sh",
    [
      join(fixture.installation, "install.sh"),
      "install",
      "--install-dir", installDirectory,
      "--bin-dir", binDirectory,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: join(fixture.root, "home"),
        PATH: `${fakeBin}:${process.env.PATH}`,
        PI_BINARY_ARGUMENT_LOG: argumentLog,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(forbidden), false);
  const launcher = join(binDirectory, "pi-wait-for-user");
  assert.equal(readlinkSync(launcher), join(installDirectory, "pi-wait-for-user"));
  assert.equal(existsSync(join(installDirectory, "question-tool", "extensions", "question-tool.ts")), true);

  rmSync(launcher);
  const activated = spawnSync(
    "sh",
    [
      join(installDirectory, "install.sh"),
      "activate",
      "--install-dir", installDirectory,
      "--bin-dir", binDirectory,
    ],
    { encoding: "utf8", env: { ...process.env, HOME: join(fixture.root, "home"), PI_BINARY_ARGUMENT_LOG: argumentLog } },
  );
  assert.equal(activated.status, 0, activated.stderr);
  assert.equal(readlinkSync(launcher), join(installDirectory, "pi-wait-for-user"));

  const removed = spawnSync(
    "sh",
    [
      join(installDirectory, "install.sh"),
      "uninstall",
      "--install-dir", installDirectory,
      "--bin-dir", binDirectory,
    ],
    { encoding: "utf8", env: { ...process.env, HOME: join(fixture.root, "home") } },
  );
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(installDirectory), false);
});
