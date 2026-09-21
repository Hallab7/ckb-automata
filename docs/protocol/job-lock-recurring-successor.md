# Job Lock Recurring Successor

A Job Cell with `remaining_runs > 1` must create exactly one successor under the
same full Job Lock hash. That successor must be included in the execution
witness's job-controlled output list and retain the committed policy type
script.

## Invariants

The successor preserves these fields byte-for-byte:

- version, flags, and state;
- `job_id`;
- trigger kind;
- policy and payload hashes;
- reward;
- advisory `not_after`; and
- owner `cancel_lock_hash`.

Its sequence is exactly the input sequence plus one with checked arithmetic.
Its run count is exactly one lower, and its remaining budget is strictly lower.
The successor budget must still fit above occupied capacity and cover its fixed
reward.

For block, epoch, and timestamp triggers, `not_before` strictly advances. Every
trigger kind must also change `trigger_params_hash`, binding a distinct next
trigger. Application policies can impose a more specific schedule.

## Verification status

- Fixture-backed CKB-VM: verified for one valid successor and mutations covering
  missing, multiple, and unlisted successors; every immutable field; policy
  type; sequence reset and overflow; run reset and increase; budget reset and
  increase; and stale trigger data.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
