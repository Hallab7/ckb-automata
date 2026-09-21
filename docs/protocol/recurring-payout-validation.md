# Recurring Payout Validation

The recurring policy is the Job Cell type script for native-CKB schedules. Its
script args are empty in V1. The policy runs beside the generic Job Lock and
re-validates the recurring intent before authorizing each non-final payout.

## Payload Proof

The execution witness retains the Job Lock request in `input_type` and reveals
the canonical `RecurringPayloadV1` bytes in `output_type`. The recurring policy
recomputes `JobDataV1.payload_hash` from its own full script hash and those
bytes, then validates:

- V1 live absolute-block job metadata with no upper bound;
- non-zero owner and recipient Script hashes;
- non-zero amount, interval, first lower bound, and total run count;
- owner, reward, and total-run consistency between payload and Job Cell; and
- `sequence + remaining_runs == total_runs`.

The same payload bytes must therefore describe every execution. The executor
cannot substitute a recipient, amount, owner, reward, or schedule.

## Exact Payout

For a non-final run, the consumed Job Cell input must use a `since` value equal
to its committed `not_before`. The transaction must contain exactly one output
whose full lock hash equals `recipient_lock_hash`. That output must carry the
exact committed `amount`, have no type script, and contain empty data.

This admits only a plain native-CKB payout. A wrong recipient, changed amount,
typed asset cell, early input, or second output to the recipient is rejected.
The Job Lock independently requires the payout to be listed among the
job-controlled outputs and conserves all Job Cell capacity across the reward,
payout, and successor.

## Verification Status

- Fixture-backed CKB-VM: verified for a valid integrated Job Lock and recurring
  policy execution.
- Mutation coverage: wrong recipient, amount, asset type, lower bound, and
  duplicate payout.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
