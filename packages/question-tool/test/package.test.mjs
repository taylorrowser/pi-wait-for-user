import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));
const manifest = JSON.parse(
	readFileSync(join(packageRoot, "package.json"), "utf8"),
);
const codingAgentRoot = join(
	repositoryRoot,
	".work",
	"pi-v0.81.1",
	"packages",
	"coding-agent",
);

test("the separately installable package declares its exact durable compatibility contract", () => {
	assert.deepEqual(manifest.pi.extensions, ["./extensions/index.ts"]);
	assert.deepEqual(manifest.piWaitForUser, {
		upstreamPiVersion: "0.81.1",
		coreProtocolVersions: [1],
		handlerId: "dev.taylorrowser.pi-question-tool.question",
		handlerVersion: 1,
		resumableHandlerVersions: [1],
		packageSchemaVersions: [1],
	});
});

test("the active patched Pi discovers the package without extension registration errors", () => {
	const cli = join(
		repositoryRoot,
		".work",
		"pi-v0.81.1",
		"packages",
		"coding-agent",
		"dist",
		"cli.js",
	);
	const result = spawnSync(
		process.execPath,
		[cli, "-e", packageRoot, "--list-models"],
		{
			cwd: repositoryRoot,
			encoding: "utf8",
			env: {
				...process.env,
				HOME: join(repositoryRoot, ".work", "question-tool-test-home"),
			},
		},
	);

	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /extension|handler|deferral/i);
});

test("the documented source installation links patched Pi and persistently installs the Question Tool", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-question-install-"));
	const prefix = join(root, "prefix");
	const home = join(root, "home");
	const environment = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		npm_config_prefix: prefix,
	};
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const pi =
		process.platform === "win32"
			? join(prefix, "pi.cmd")
			: join(prefix, "bin", "pi");
	const run = (command, args, cwd = repositoryRoot) =>
		spawnSync(command, args, { cwd, encoding: "utf8", env: environment });

	try {
		const link = run(npm, ["link"], codingAgentRoot);
		assert.equal(link.status, 0, link.stderr);

		const version = run(pi, ["--version"]);
		assert.equal(version.status, 0, version.stderr);
		assert.equal(version.stdout.trim(), "0.81.1");

		const conformance = run(pi, ["conformance"]);
		assert.equal(conformance.status, 0, conformance.stderr);
		assert.match(conformance.stdout, /Deferred conformance passed \(8\/8\)/);

		const install = run(pi, ["install", packageRoot]);
		assert.equal(install.status, 0, install.stderr);

		const list = run(pi, ["list"]);
		assert.equal(list.status, 0, list.stderr);
		assert.match(
			list.stdout,
			new RegExp(packageRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);

		const startup = run(pi, ["--list-models"]);
		assert.equal(startup.status, 0, startup.stderr);
		assert.doesNotMatch(startup.stderr, /extension|handler|deferral/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("npm pack contains the extension, public contracts, and documentation", () => {
	const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: packageRoot,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	const files = JSON.parse(result.stdout)[0].files.map((file) => file.path);
	assert.ok(files.includes("extensions/index.ts"));
	assert.ok(files.includes("src/index.ts"));
	assert.ok(files.includes("README.md"));
	assert.ok(files.every((file) => !file.startsWith("test/")));
});
