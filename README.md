# Pi Wait for User

This repository is the Source Repository for Pi durable-interaction content. Its default branch owns only:

- the 20 declarative Git Patches under [`patches/active`](patches/active);
- the independently versioned ordinary Pi package [`@taylorrowser/pi-question-tool`](packages/question-tool); and
- content-facing tests and documentation for those artifacts.

[PorcuPi v0.1.0](https://github.com/taylorrowser/PorcuPi/releases/tag/v0.1.0) owns macOS/Linux composition and lifecycle behavior: exact Pi Base selection, Patch selection and digests, fixed builds, immutable Compositions, activation, launch, verification, rollback, process leases, optional `pi` ownership, cleanup, and uninstall. This repository has no active installer, launcher, manager, release channel, signing system, publisher-built payload, updater, retention state, legacy adoption path, or Windows lifecycle implementation.

## Use through PorcuPi

Read [PorcuPi's installation guide](https://github.com/taylorrowser/PorcuPi/blob/v0.1.0/docs/install.md), install that exact release, and clone this repository. Bind selection to the checkout's full commit rather than a moving branch:

```sh
git clone https://github.com/taylorrowser/pi-wait-for-user.git
cd pi-wait-for-user
source_commit=$(git rev-parse HEAD)
porcupi add "https://github.com/taylorrowser/pi-wait-for-user@$source_commit"
```

In the guided flow, select the desired Patches. The root [`porcupi.json`](porcupi.json) adds display names and declares exact compatibility with Pi Base `v0.81.1` at `20be4b18d4c57487f8993d2762bace129f0cf7c6`; it adds no dependencies, ordering, hooks, scripts, recipes, or executable behavior. Selection changes remain pending until explicitly composed:

```sh
porcupi apply
```

Install the Question Tool separately through Managed Pi's ordinary public package command:

```sh
porcupi install "$PWD/packages/question-tool"
porcupi list
```

`porcupi install` and `porcupi list` are forwarded unchanged to Pi. The Question Tool is not bundled with the Patches, automatically selected, or treated as a PorcuPi dependency. See its [package guide](packages/question-tool/README.md) for behavior and compatibility.

## Existing managed installations

Do **not** install PorcuPi over an existing `pi-wait-for-user` Managed Installation or copy its state or payloads. First run the installed historical manager's own uninstall:

```sh
pi managed uninstall
```

If Stock Pi still owns `pi`, invoke the historical compatibility entrypoint instead:

```sh
pi-wait-for-user managed uninstall
```

Let live sessions exit and retry if uninstall defers cleanup. If the old manager cannot execute, use the instructions from the exact historical tag or GitHub Release that installed it. Only after old-manager uninstall succeeds should you install PorcuPi and select this Source Repository. PorcuPi performs no automatic legacy adoption or in-place payload migration.

Historical tags and [published GitHub Releases](https://github.com/taylorrowser/pi-wait-for-user/releases) remain immutable and available for old-manager recovery and uninstall. Their manager code and assets are historical release content; deleting duplicate machinery from the default branch does not alter them.

## Trust boundary

Selecting a commit trusts its Patch-modified code and the Question Tool package to run with your user authority. Exact commits, Patch SHA-256 values, and PorcuPi receipts support reproducibility and local-integrity checks; they do not authenticate publishers, establish provenance, or sandbox selected code. Use an external OS account, VM, or container when that authority is inappropriate.

## Development

Run the default source-content suite with Node.js 22.19 or newer:

```sh
npm test
```

It validates every regular Patch and its narrow metadata and runs the dependency-free Question Tool contract/lifecycle tests. Full patched-Pi behavior, Question Tool installation/discovery, and all 20 Patches are exercised through PorcuPi's public-process real-source gate rather than a second lifecycle implementation in this repository. See [source ownership](docs/adr/0001-source-content-only-after-porcupi-handoff.md).
