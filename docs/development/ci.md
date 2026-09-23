# Continuous Integration

The `Foundation` workflow runs on pull requests and pushes to `main`. GitHub
Actions are pinned by commit SHA, tool versions come from the repository pins,
and dependency caches are keyed by the applicable lockfiles and toolchain.

Configure branch protection to require these stable job names:

- `install`
- `lint`
- `typecheck`
- `unit-test`
- `backend-integration`
- `contract-build`
- `contract-test`
- `contract-fuzz-smoke`

The contract build uploads the five verified RISC-V binaries plus their build
manifest as a 14-day artifact named with the source revision. The manifest
contains binary and schema hashes, the source revision, and the pinned builder
base image and Dockerfile hash. Missing files, dirty CI source, or non-identical
clean container builds fail the job.

The contract test job also regenerates cycle and occupied-capacity measurements
in memory and compares them with `contracts/benchmarks.json`. See
`docs/testing/contract-benchmarks.md` for the intentional update procedure.

## Local parity

Run the complete deterministic foundation suite with:

```text
npx --yes pnpm@12.5.1 verify
```

The unit-test job includes a controlled failure path. On PowerShell, verify that
the job rejects a broken test with:

```powershell
$env:AUTOMATA_CI_BREAK = "1"
npx --yes pnpm@12.5.1 test
Remove-Item Env:AUTOMATA_CI_BREAK
```

The middle command must exit nonzero. Run it again without the environment
variable to verify the successful path.

The `backend-integration` job runs the same composed NestJS suite against a fresh database and an
upgrade from migration 3. It uses isolated PostgreSQL and Redis services plus in-process CKB RPC and
webhook receivers; no live chain or external webhook is contacted.

The fuzz smoke job exercises the contract parsers and arithmetic helpers with
fixed seeds on every foundation run. The separate `Contract Fuzz` workflow runs
the same targets for five minutes each every Monday and can also be dispatched
manually. Crash artifacts are retained for 14 days.
