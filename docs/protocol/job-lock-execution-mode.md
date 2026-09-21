# Job Lock Execution Mode

Permissionless execution uses witness mode `0`. The first Job Lock group
input's `input_type` is exactly 37 bytes:

| Offset | Size | Value                                  |
| ------ | ---- | -------------------------------------- |
| `0`    | 1    | execution mode `0`                     |
| `1`    | 4    | reward output index, little-endian u32 |
| `5`    | 32   | executor's full lock-script hash       |

No other payload length or execution mode value is accepted.

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

## Verification status

- Fixture-backed CKB-VM: verified for a valid execution and mutations of policy,
  reward amount, reward recipient, mode, and executor identity. A signed
  transaction copied and changed to redirect the reward is rejected.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
