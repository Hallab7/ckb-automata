# Continuous Integration

The `Foundation` workflow runs on pull requests and pushes to `main`. GitHub
Actions are pinned by commit SHA, tool versions come from the repository pins,
and dependency caches are keyed by the applicable lockfiles and toolchain.

Configure branch protection to require these stable job names:

- `install`
- `lint`
- `typecheck`
- `unit-test`
- `contract-build`
- `contract-test`

The contract build uploads the four RISC-V binaries as a 14-day artifact named
with the source revision. Missing binaries fail the job.

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
