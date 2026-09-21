# Job Lock Execution Mode

Permissionless execution uses witness mode `0`. The first Job Lock group
input's `input_type` has this canonical layout:

| Offset | Size      | Value                                      |
| ------ | --------- | ------------------------------------------ |
| `0`    | 1         | execution mode `0`                         |
| `1`    | 4         | reward output index, little-endian u32     |
| `5`    | 32        | executor's full lock-script hash           |
| `37`   | 1         | job-controlled output count, from 1 to 16  |
| `38`   | count x 4 | distinct output indices, little-endian u32 |

The byte length must be exactly `38 + count * 4`. Duplicate indices, a missing
reward index, any other payload length, or another execution mode value is
rejected.

## Commitments

The consumed Job Cell must have a type script, and its actual full type-script
hash must equal `policy_script_hash` in `JobDataV1`. CKB executes that type
script in the same transaction, so replacing or removing the policy cannot
bypass policy validation.

The executor identity is the full lock-script hash in the execution witness.
The transaction must co-spend a distinct input with that lock hash. The indexed
reward output must then:

- have capacity exactly equal to the Job Cell's committed `reward`;
- use the committed executor lock hash;
- have no type script; and
- have empty data.

The executor input's wallet lock verifies its signature over the transaction.
Changing the reward output or witness identity therefore either violates the
Job Lock commitments or invalidates the executor wallet signature.

## Value boundary

The capacities of the declared job-controlled outputs must add up exactly to
the consumed Job Cell capacity. The list covers the reward and every policy
authorized application payout, successor, or owner refund. The committed policy
type script determines which application outputs are valid; the Job Lock owns
the generic accounting boundary. Later lifecycle rules further constrain the
terminal and recurring shapes.

For a one-shot job, the [terminal rule](job-lock-one-shot.md) additionally
forbids every output under the active Job Lock.

The Job Cell's `remaining_budget` must fit above its occupied capacity, and the
reward cannot exceed that budget. Every controlled output must itself meet its
occupied capacity. All arithmetic is checked.

Executor fee inputs and change outputs are deliberately outside the controlled
list. Reducing executor change can pay a larger fee, but it cannot reduce the
sum returned from the Job Cell. Omitting a controlled output, counting one
twice, or moving capacity to an unlisted output fails validation.

## Verification status

- Fixture-backed CKB-VM: verified for a valid execution and mutations of policy,
  reward amount, reward recipient, mode, and executor identity. A signed
  transaction copied and changed to redirect the reward is rejected. Capacity
  mutations cover reward, application payout, owner refund, executor change,
  duplicate or missing indices, and leakage to an unlisted output.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
