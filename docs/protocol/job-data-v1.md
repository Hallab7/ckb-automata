# JobDataV1 Review

The sole canonical binary definition is
[`contracts/schemas/job_v1.mol`](../../contracts/schemas/job_v1.mol). This
document reviews its semantics and must not be used to generate bindings.

## Encoding decisions

- Fixed-width integers are unsigned little-endian values.
- Capacity amounts are expressed in shannons; counters are dimensionless.
- Time eligibility uses raw absolute CKB `since` values, never JavaScript
  numbers or wall-clock claims.
- V1 accepts version `1`, flags `0`, state `LIVE`, and trigger assignments 1
  through 6. Every unassigned value is reserved and rejected.
- A live cell always has at least one remaining run. The current action is
  included in that count.
- Terminal outcomes are represented by consumption without a Job Cell
  successor. Operational transaction confidence belongs to the event model.
- Hash fields use the exact domain-separated rules embedded beside the schema.

## Lifecycle coverage

| Required invariant              | Schema commitment                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| At most one reward              | `reward` fixes the maximum payment for one consumption; the Job Lock verifies output count and amount.                              |
| One-shot has no successor       | `remaining_runs == 1` identifies the terminal action.                                                                               |
| Recurrence has one successor    | `remaining_runs > 1` requires exactly one policy-constrained successor.                                                             |
| Immutable identity and policy   | `job_id`, `policy_script_hash`, `payload_hash`, trigger fields, and owner/recipient commitments are preserved or checked by policy. |
| Sequence advances once          | `sequence` is an unsigned counter and the successor must equal the input plus one.                                                  |
| Runs and budget do not increase | `remaining_runs` and `remaining_budget` are explicit successor comparison fields.                                                   |
| Owner exits pay no reward       | Cancellation and recovery are witness modes; the lock rejects a reward output for either mode.                                      |
| Unspent value is preserved      | `remaining_budget` participates in capacity conservation and successor/refund checks.                                               |
| Reward binds to executor        | `reward` is fixed here; execution witness rules bind the permitted output identity.                                                 |
| External indexes are not proof  | No indexer, API, queue, or wall-clock field exists in the schema.                                                                   |

Application-specific state belongs in canonical policy payload bytes committed
by `payload_hash`. The generic schema intentionally contains no DAO deposit,
withdrawal, preparation, or claim fields and no campaign-specific stage names.
