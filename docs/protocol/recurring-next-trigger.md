# Recurring Next Trigger

Every recurring lower bound is derived from immutable payload fields and the
Job Cell sequence:

```text
scheduled_lower_bound(sequence) =
  first_not_before + sequence * interval_blocks
```

Both multiplication and addition use checked unsigned arithmetic. The result
must remain a valid absolute block-number `since` value. Zero intervals,
overflow, and values above the 56-bit block-number range are rejected.

## Successor Rule

The recurring policy verifies that the consumed Job Cell already carries the
lower bound and trigger hash for its current sequence. A non-final successor
must then have:

```text
sequence = input.sequence + 1
not_before = scheduled_lower_bound(sequence)
trigger_params_hash = H(
  "ckb-automata/trigger-params/v1",
  uint16_le(ABSOLUTE_BLOCK_SINCE) || uint64_le(not_before)
)
```

The generic Job Lock independently enforces the one-step sequence increment,
decrements remaining runs, and requires the lower bound to advance.

## Late Execution

An executor may submit an eligible transaction at any later block while the
Job Cell input continues to carry its original committed `since` value. The
policy does not accept an observed block height or execution timestamp as an
input to the successor calculation. A delayed run therefore schedules the next
run at the original cadence; it cannot shift the series forward or silently
skip intervals.

## Verification Status

- Fixture-backed CKB-VM: verified for the exact next lower bound and trigger
  hash, plus rejection of a skipped interval, overflow, and zero interval.
- Pure schedule tests prove the next value depends only on first lower bound,
  sequence, and interval, which models on-time and late inclusion identically.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
