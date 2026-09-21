# Job Lock Owner Mode

Job Lock V1 reserves two one-byte witness modes in the first group input's
`input_type` field:

| Value | Operation |
| ----- | --------- |
| `1`   | Cancel    |
| `2`   | Recover   |

Both modes are owner-authorized exits and remain separate from the variable
length [execution request](job-lock-execution-mode.md). Cancellation is the
normal exit for a supported live job. Recovery remains a distinct escape path
for a later validation rule.

## Authorization

The transaction must co-spend a distinct normal wallet input whose complete
lock-script hash equals the Job Cell's `cancel_lock_hash`. Comparing the full
hash commits the code hash, hash type, and arguments. The matching wallet lock
script runs as its own CKB lock group and is responsible for signature
validation; the Job Lock does not inspect or reproduce wallet signatures.

The owner authorization input cannot be another input in the Job Lock group,
and the committed owner hash cannot equal the active Job Lock hash.

## Cancellation

Cancellation accepts exactly one Job Cell in the active lock group. The job
must use schema version `1`, reserved flags `0`, state `LIVE`, a supported
trigger, at least one remaining run, and the exact policy type script committed
by `policy_script_hash`.

Output zero is the refund and must have all of the following properties:

- capacity exactly equal to the consumed Job Cell capacity;
- lock hash equal to `cancel_lock_hash`;
- no type script; and
- empty cell data.

No output may use the active Job Lock, so cancellation cannot create a future
recurrence. Returning the complete Job Cell capacity leaves no job-funded value
for an executor reward. The co-spent wallet input pays transaction fees and may
receive separate change; unrelated owner-funded outputs are outside the Job
Cell value boundary.

The committed policy type script runs because it is present on the consumed Job
Cell. It remains responsible for any application cells co-spent by the
cancellation transaction, so removing or substituting the policy cannot bypass
application-specific preservation rules. This keeps the Job Cell refund
independently reconstructible without an API, database, queue, or hosted
frontend.

Execution and cancellation spend the same Job Cell outpoint. CKB's single-spend
rule therefore resolves a race atomically: one transaction can commit, and the
other becomes conflicted without creating a second lifecycle transition.

## Verification status

- Fixture-backed CKB-VM: verified with the compiled Job Lock and bundled
  secp256k1 wallet lock for one-shot and recurring cancellation, standalone
  recovery, wrong owner, missing owner input, invalid signature, policy
  substitution, diverted Job Cell capacity, attempted recurrence, and malformed
  execution input. A valid cancellation and a valid execution are also built
  against the same outpoint to prove the atomic race boundary.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
