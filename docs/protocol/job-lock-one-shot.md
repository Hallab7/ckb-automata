# Job Lock One-Shot Termination

A Job Cell with `remaining_runs == 1` is on its terminal execution. The
transaction must not create any output locked by the same full Job Lock script
hash. This check covers outputs whether or not an executor lists them as
job-controlled, so a hidden or fee-funded successor is also rejected.

The terminal transaction still obeys the execution-mode commitments:

- the committed policy script validates application-specific routing;
- the reward amount and executor recipient are exact;
- all Job Cell capacity is assigned to the distinct controlled output list; and
- executor fee inputs and change remain outside Job Cell accounting.

`remaining_runs == 0` is invalid input data. Values above one are handled by the
recurring successor rules and are not accepted as terminal evidence.

## Verification status

- Fixture-backed CKB-VM: zero successors succeeds; one and two successor outputs
  fail even when all capacity remains conserved. A zero run count also fails.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
