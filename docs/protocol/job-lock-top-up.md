# Job Lock Top-Up Mode

Witness mode `3` lets the committed owner increase a live Job Cell's executor
reward, remaining budget, and backing capacity without replacing its intent.
For recurring jobs, the payload fixes the per-run reward, so their top-up path
increases remaining budget and backing capacity without changing reward.
The five-byte `input_type` payload is the mode byte followed by the successor
output index as a little-endian `u32`.

## Authorization and Successor

The transaction must co-spend the wallet input identified by
`cancel_lock_hash`. The input job must be a supported live V1 job with its
committed policy type script. Exactly one output may use the active Job Lock,
and the witness must point to that output. Its type script must remain the
committed policy.

The successor preserves these fields byte-for-byte:

- version, flags, identity, sequence, and state;
- trigger kind, trigger parameters, and both time bounds;
- policy and payload commitments;
- remaining run count; and
- owner cancellation lock.

The payload commitment preserves policy-specific recipients and limits. A
top-up cannot silently become a different job.

## Funding Rules

Reward and remaining budget may only increase, and at least one must increase.
The successor reward must fit within its remaining budget. The budget must fit
above the successor's occupied capacity, and total successor capacity cannot be
lower than the consumed Job Cell capacity. Additional capacity and transaction
fees come from the owner's co-spent wallet input.

Top-up pays no executor reward and does not advance sequence, trigger, or run
count. It changes funding authority only; a later execution must still satisfy
all normal trigger, policy, reward, and successor rules.

## Verification Status

- Fixture-backed CKB-VM: verified for a valid reward, budget, and capacity
  increase; missing owner; missing or multiple successors; policy substitution;
  every immutable field; reward or budget decrease; no-op updates; unfunded
  budget; reward above budget; and reduced successor capacity.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
