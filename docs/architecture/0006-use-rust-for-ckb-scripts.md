# ADR 0006: Use Rust for CKB Scripts

- Status: Accepted
- Date: 2026-09-21
- Scope: On-chain validation and contract tests

## Context

Job Lock and policy scripts must enforce authority, value conservation,
recurrence, reward binding, cancellation, and recovery inside CKB-VM. Their
binary formats must be shared with TypeScript consumers and tested against real
transaction structures.

## Decision

Implement CKB scripts as Rust `no_std` crates using `ckb-std`. Define canonical
binary data in Molecule schemas, generate bindings, and test scripts with
`ckb-testtool`. Pin the Rust toolchain, RISC-V target tooling, and reproducible
builder environment before publishing binaries.

## Alternatives considered

- C contracts using the CKB system-script toolchain. This can minimize binaries
  but provides fewer language-level safety tools for the project team.
- JavaScript or TypeScript contracts. They do not target the required CKB-VM
  execution environment for these scripts.
- Off-chain validation only. An executor or API cannot provide consensus-level
  guarantees about recipients, rewards, successors, or value conservation.

## Consequences

- Checked arithmetic, explicit parsing, and reusable Rust tests support contract
  assurance.
- Developers need pinned Rust and RISC-V tooling in addition to Node and pnpm.
- Generated Molecule bindings and golden vectors must remain synchronized across
  Rust and TypeScript.
- Cycle count, binary size, occupied capacity, fuzzing, and reproducible builds
  are mandatory release concerns.

## Reversal cost

Rewriting scripts changes deployed code hashes and requires new fixtures,
benchmarks, audits, manifests, migrations, and owner recovery planning. The cost
is very high after any funded Job Cell exists, so a language change requires a
new contract version rather than an in-place replacement.
