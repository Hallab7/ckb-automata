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
The recurring policy requires the controlled set to contain exactly three distinct outputs: the
executor reward, recipient payout, and unique successor. The successor capacity must equal the
input Job Cell capacity minus exactly one reward and one payout, and its remaining budget must equal
the input budget minus exactly one reward. The Job Lock independently conserves that same complete
capacity across the declared set. An executor cannot declare an additional controlled output,
shrink the successor, or reduce its future reward budget.

## Verification Status

- Fixture-backed CKB-VM: verified for a valid integrated Job Lock and recurring
  policy execution.
- Mutation coverage: wrong recipient, amount, asset type, lower bound, duplicate payout, additional
  controlled output, reduced successor capacity, and reduced successor budget.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
