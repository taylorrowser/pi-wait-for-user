import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("the managed bootstrap authenticates the Release Channel before selecting exact payloads", () => {
  const bootstrap = readFileSync(join(repositoryRoot, "scripts", "bootstrap.sh"), "utf8");

  assert.doesNotMatch(bootstrap, /for command in npm git/);
  assert.match(bootstrap, /release-trust\.json/);
  assert.match(bootstrap, /BEGIN PUBLIC KEY/);
  assert.match(bootstrap, /release-channel/);
  assert.match(bootstrap, /release-manifest/);
  assert.match(bootstrap, /managed.*install/i);
  assert.match(bootstrap, /\(\?:darwin-arm64\|linux-/);
  assert.doesNotMatch(bootstrap, /darwin-x64/);
});

test("the managed HTTPS bootstrap rejects Intel macOS before any download", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intel-bootstrap-"));
  temporaryRoots.push(root);
  const fakeBin = join(root, "bin");
  const fetchLog = join(root, "fetch-attempted");
  const modulePath = join(root, "bootstrap.mjs");
  const fakeNode = join(fakeBin, "node");
  mkdirSync(fakeBin);
  writeFileSync(fakeNode, `#!/bin/sh
if [ "\${1:-}" = "-p" ]; then
  echo 22.19
  exit 0
fi
{
  printf '%s\\n' \
    'Object.defineProperty(process, "platform", { value: "darwin" });' \
    'Object.defineProperty(process, "arch", { value: "x64" });' \
    'globalThis.fetch = async () => { (await import("node:fs")).writeFileSync(${JSON.stringify(fetchLog)}, "attempted"); throw new Error("network attempted"); };'
  cat
} > ${JSON.stringify(modulePath)}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(modulePath)}
`);
  chmodSync(fakeNode, 0o755);

  const result = spawnSync("sh", [join(repositoryRoot, "scripts", "bootstrap.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Managed installation does not support darwin-x64/);
  assert.equal(existsSync(fetchLog), false);
});

test("the bootstrap uses signed artifact descriptors rather than an unauthenticated checksum projection", () => {
  const bootstrap = readFileSync(join(repositoryRoot, "scripts", "bootstrap.sh"), "utf8");

  assert.doesNotMatch(bootstrap, /SHA256SUMS/);
  assert.match(bootstrap, /Release Channel manifest digest mismatch/);
  assert.match(bootstrap, /Manager Release.*managerArtifact/s);
  assert.match(bootstrap, /Downstream Release.*releaseArtifact/s);
  assert.match(bootstrap, /bytes\.length !== expected\.size/);
  assert.match(bootstrap, /createHash\("sha256"\).*expected\.sha256/s);
});

test("Windows x64 and ARM64 payloads embed the signed managed PowerShell bootstrap", () => {
  for (const platformName of ["windows-x64", "windows-arm64"]) {
    const root = mkdtempSync(join(tmpdir(), `pi-${platformName}-package-`));
    temporaryRoots.push(root);
    const input = join(root, "input", platformName);
    const output = join(root, "output");
    mkdirSync(input, { recursive: true });
    writeFileSync(join(input, "pi.exe"), "fixture Windows executable");
    execFileSync(process.execPath, [
      join(repositoryRoot, "scripts", "package-binaries.mjs"),
      "--input", join(root, "input"), "--output", output, "--platform", platformName,
    ], { cwd: repositoryRoot });
    const archive = join(output, `pi-wait-for-user-${platformName}.zip`);
    const extracted = join(root, "extracted");
    mkdirSync(extracted);
    execFileSync("unzip", ["-q", archive, "-d", extracted]);
    const payload = join(extracted, "pi-wait-for-user");
    assert.equal(existsSync(join(payload, "install.ps1")), true);
    assert.equal(existsSync(join(payload, "managed-install", "windows-bootstrap.mjs")), true);
    assert.equal(existsSync(join(payload, "managed-install", "lib", "release-metadata.mjs")), true);
    const bootstrap = readFileSync(join(payload, "managed-install", "windows-bootstrap.mjs"), "utf8");
    assert.ok(bootstrap.indexOf("verifyChannelSelection(channelEnvelope") < bootstrap.indexOf("download(manifestUrl"));
    assert.equal(existsSync(join(payload, "install.sh")), false);
    const metadata = JSON.parse(readFileSync(`${archive}.metadata.json`, "utf8"));
    verifyReleasePayloads(extracted, metadata.payload);
  }
});

test("the binary packager rejects the retired Intel macOS target", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intel-package-"));
  temporaryRoots.push(root);
  const result = spawnSync(process.execPath, [
    join(repositoryRoot, "scripts", "package-binaries.mjs"),
    "--input", join(root, "input"),
    "--output", join(root, "output"),
    "--platform", "darwin-x64",
  ], { cwd: repositoryRoot, encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: package-binaries/);
  assert.equal(existsSync(join(root, "output")), false);
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
  mkdirSync(binDirectory);
  const launcher = join(binDirectory, "pi-wait-for-user");
  writeFileSync(launcher, "foreign\n");
  const collision = spawnSync(
    "sh",
    [
      join(fixture.installation, "install.sh"),
      "install",
      "--install-dir", installDirectory,
      "--bin-dir", binDirectory,
    ],
    { encoding: "utf8", env: { ...process.env, HOME: join(fixture.root, "home"), PATH: `${fakeBin}:${process.env.PATH}` } },
  );
  assert.notEqual(collision.status, 0);
  assert.equal(readFileSync(launcher, "utf8"), "foreign\n");
  assert.equal(existsSync(installDirectory), false);
  rmSync(launcher);

  symlinkSync(join(installDirectory, "pi-wait-for-user"), launcher);
  const unownedMatchingLink = spawnSync(
    "sh",
    [join(fixture.installation, "install.sh"), "install", "--install-dir", installDirectory, "--bin-dir", binDirectory],
    { encoding: "utf8", env: { ...process.env, HOME: join(fixture.root, "home"), PATH: `${fakeBin}:${process.env.PATH}` } },
  );
  assert.notEqual(unownedMatchingLink.status, 0);
  assert.equal(readlinkSync(launcher), join(installDirectory, "pi-wait-for-user"));
  assert.equal(existsSync(installDirectory), false);
  rmSync(launcher);

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
