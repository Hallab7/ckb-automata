# Toolchain

CKB Automata uses exact tool and dependency versions. The machine-readable
source is [`config/versions.json`](../../config/versions.json); package and Rust
manifests repeat the applicable values so their native tools enforce them.

## Required host tools

| Tool        | Version                        |
| ----------- | ------------------------------ |
| Node.js     | `24.11.1`                      |
| pnpm        | `12.5.1`                       |
| Rust        | `1.93.1`                       |
| Rust target | `riscv64imac-unknown-none-elf` |

Use npm's exact-package runner to bootstrap the pnpm version from `package.json`.
This path is used because Corepack `0.34.2`, bundled with the pinned Windows Node
distribution, expects pnpm's older launcher layout and cannot start pnpm 12.
Rustup reads `rust-toolchain.toml` and installs the pinned target. `.npmrc`
rejects an incompatible Node or pnpm runtime and makes newly saved dependencies
exact.

The repository Cargo configuration provides these stable commands:

```text
cargo test-native --locked
cargo build-contracts --locked
npx --yes pnpm@12.5.1 contracts:check-reproducible
```

The first command runs the native contract harness. The second builds every
script for the pinned RISC-V target in release mode. The reproducibility check
builds into two isolated target directories and compares every binary by
SHA-256.

## Install

On Windows PowerShell and Linux shells, the repository install command is:

```text
npx --yes pnpm@12.5.1 install --frozen-lockfile
npx --yes pnpm@12.5.1 check:versions
```

The version check rejects ranges, tags such as `latest`, mismatches between the
version policy and package manifest, and a Node runtime different from the
project pin.

## Docker images

Build and local-service images are locked by exact tag and multi-platform digest
in `config/versions.json`. Dockerfiles and Compose files must use those complete
references. Updating an image requires verifying its supported architectures,
changing the lock entry, and regenerating affected evidence.

## Dependency updates

Direct dependencies use exact versions. An update must change the package
manifest, lockfile, and `config/versions.json` in the same commit when the
dependency is part of the shared version policy. CI installs with
`--frozen-lockfile`; it must never resolve an unbounded version tag.
