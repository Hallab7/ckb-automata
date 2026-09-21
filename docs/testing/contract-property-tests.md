# Contract Property Tests

The native CKB-VM suite combines deterministic regression fixtures with
bounded property generation. Deterministic cases guarantee that every required
mutation class always runs; generated cases vary the selected class and valid
executor funding to exercise the same invariants across repeated transactions.

## Generated Mutation Classes

| Invariant        | Generated mutation                       | Expected script error |
| ---------------- | ---------------------------------------- | --------------------- |
| Capacity control | Uncontrolled Job Cell value              | `28`                  |
| Sequence         | Non-incrementing successor               | `21`                  |
| Run count        | Non-decrementing successor               | `27`                  |
| Policy hash      | Changed policy data or type              | `25` or `17`          |
| Payload hash     | Changed successor payload commitment     | `25`                  |
| Recipient        | Wrong, changed, or duplicated payout     | `32`                  |
| Owner            | Changed cancellation/refund commitment   | `25`                  |
| Reward           | Changed recurring successor reward       | `25`                  |
| Successor count  | Missing or multiple recurring successors | `24`                  |

The property runner uses a fixed bounded case count suitable for every CI run.
Shrinking remains enabled, so a future failing generated input is reduced to a
minimal reproducible case by the test framework.

## Valid Generation

Valid recurring transactions vary executor-provided fee funding while keeping
the Job Cell-controlled reward, payout, and successor unchanged. This proves
that unrelated executor change does not alter application validity or leak
into Job Cell conservation.

## Verification Status

- Fixture-backed CKB-VM property cases: verified locally.
- Stable rejection-code assertions: verified for every listed class.
- Deterministic valid and invalid regression fixtures remain in the same suite.
- Longer fuzzing and scheduled random campaigns are handled separately.
