# Recurring Distribution Payload V1

`RecurringPayloadV1` is the canonical immutable intent for native-CKB recurring
distributions. Its Molecule definition is
[`recurring_v1.mol`](../../contracts/schemas/recurring_v1.mol), with generated
Rust and TypeScript codecs checked into the repository.

## Immutable Intent

| Field                 | Rule                                                          |
| --------------------- | ------------------------------------------------------------- |
| `version`             | Exactly `1`                                                   |
| `owner_lock_hash`     | Full owner Script hash; equals the Job Cell cancellation lock |
| `recipient_lock_hash` | Full Script hash of the only payout recipient                 |
| `amount`              | Exact non-zero shannon payout per run                         |
| `interval_blocks`     | Exact non-zero block distance between scheduled lower bounds  |
| `first_not_before`    | Non-zero absolute block-number `since` for run zero           |
| `total_runs`          | Exact non-zero number of payouts                              |
| `reward`              | Exact executor reward per run                                 |
| `final_refund_kind`   | `0`: return all allowed residual value to the owner           |

Values `1..255` of `final_refund_kind` are reserved. V1 does not permit an
executor-selected final recipient, partial residual retention, or silent
burning. The payload bytes are immutable across the entire schedule.

## Mutable Progress

Only these `JobDataV1` fields advance during valid recurring execution:

| Field                 | Successor rule                                    |
| --------------------- | ------------------------------------------------- |
| `sequence`            | Previous value plus one                           |
| `trigger_params_hash` | Recomputed for the next committed lower bound     |
| `not_before`          | `first_not_before + sequence * interval_blocks`   |
| `remaining_runs`      | Previous value minus one                          |
| `remaining_budget`    | Reduced by the exact payout and reward accounting |

The next lower bound derives from the committed schedule, not the block at
which an executor happens to submit a transaction. Owner, recipient, amount,
interval, first lower bound, total run count, reward, refund behavior, policy
hash, payload hash, and cancellation lock remain immutable.

## Commitment

`JobDataV1.payload_hash` is BLAKE2b-256 with CKB personalization over:

```text
"ckb-automata/policy-payload/v1" || 0x00 ||
uint32_le(body_length) || policy_script_hash || molecule_payload_bytes
```

The committed fixture proves identical Molecule bytes and payload hashes in
Rust and TypeScript. Boundary tests reject zero amount, interval, first lower
bound, or run count; a non-block `since` range; and reserved refund behavior.

## Verification Status

- Schema review and generated-code drift check: verified locally.
- Rust and TypeScript codec/hash vector: verified locally.
- On-chain payout and successor enforcement: implemented in subsequent units.
- Local chain and public testnet: not exercised or claimed in this unit.
