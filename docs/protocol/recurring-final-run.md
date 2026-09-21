# Recurring Final Run

A recurring Job Cell becomes terminal only when its committed
`remaining_runs` is exactly one. The transaction still performs the final
payout and executor reward, but creates no Job Cell successor.

## Canonical Controlled Outputs

The execution witness must list exactly three distinct job-controlled outputs
in this order:

1. The plain executor reward output at the witness-committed lock and
   `JobDataV1.reward` amount.
2. The plain payout output at `recipient_lock_hash` and the payload's exact
   per-run amount.
3. The plain owner residual output at `owner_lock_hash`.

The residual amount is derived without executor input:

```text
owner_residual = job_input_capacity - reward - payout_amount
```

Checked subtraction rejects an underfunded final action. The exact residual
output prevents retaining, redirecting, or burning Job Cell value. Executor fee
change remains outside the job-controlled output set and is funded by the
executor's separate input.

The recurring policy rejects any output using the consumed Job Cell lock. The
generic Job Lock independently requires no successor for `remaining_runs == 1`
and conserves the sum of all controlled outputs against the input capacity.

## Run Count Boundary

`sequence + remaining_runs == total_runs` must hold throughout the schedule.
Consuming a cell with two runs left without a successor fails, as does creating
a successor after the final run. The resulting schedule produces exactly
`total_runs` committed payouts.

## Verification Status

- Fixture-backed CKB-VM: verified for a valid third and final run after a
  three-run schedule.
- Mutation coverage: one-run-early termination, successor after the last run,
  residual one shannon low/high, redirected residual, and missing payout.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
