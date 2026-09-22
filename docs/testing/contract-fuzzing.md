# Contract Fuzzing

The contract fuzz workspace treats parser and arithmetic panics as release
blockers. It uses a pinned Rust nightly, a pinned `cargo-fuzz` release, and
fixed seeds so a failed campaign can be replayed from its command and artifact.

## Targets

| Target                  | Coverage                                                        |
| ----------------------- | --------------------------------------------------------------- |
| `molecule_parsing`      | Job, campaign, and recurring Molecule readers                   |
| `witness_arithmetic`    | Witness mode dispatch, schedule arithmetic, and output matching |
| `malformed_transaction` | CKB transaction decoding and access after successful decoding   |

The fuzz-only crate includes the production parser and arithmetic sources
directly. This keeps the harnesses aligned with the code executed by the CKB
scripts instead of maintaining test-only copies.

## Local Commands

Run the bounded campaign used by continuous integration:

```text
npx --yes pnpm@12.5.1 contracts:fuzz:smoke
```

Run the extended five-minute-per-target campaign:

```text
npx --yes pnpm@12.5.1 contracts:fuzz:long
```

On Windows, the runner uses the pinned Linux Rust container because libFuzzer
does not provide a usable native Windows runtime for this workspace. Linux runs
`cargo fuzz` directly. Corpus and crash-artifact directories remain untracked;
preserve any crash input separately before cleaning a worktree.

## Automation

The `Foundation` workflow runs 256 inputs per target. The scheduled
`Contract Fuzz` workflow runs every Monday at 02:17 UTC and spends five minutes
on each target. A failed scheduled run uploads `fuzz/artifacts` for replay.

The reproducible seeds are `424242`, `424243`, and `424244` in target order.
