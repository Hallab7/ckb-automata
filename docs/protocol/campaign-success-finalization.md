# Campaign Success Finalization

Success finalization consumes one open campaign and its one-shot deadline Job
Cell in the same transaction. The Job Cell uses the deadline policy type script,
whose 32-byte args are the full type-script hash of the expected campaign.

## Eligibility and Outcome

The Job Cell commits an absolute block `not_before` equal to the campaign's
`deadline_since`. Its input uses that exact `since` value, so CKB consensus
rejects the transaction before the lower bound. The campaign type independently
requires an input carrying the same value.

The scripts derive success from the consumed campaign data:

```text
state == OPEN
pledged >= target
```

No executor-supplied outcome is accepted.

## Atomic Outputs

The campaign value boundary requires exactly one plain output whose full lock
hash equals `success_lock_hash` and whose capacity equals `pledged`. It also
requires exactly one campaign-type successor marked `SUCCEEDED`, preserving
every other campaign field and carrying only its exact occupied capacity. The
campaign input capacity must equal the payout plus that terminal marker.

The deadline policy independently finds the committed campaign input and the
same unique fixed-recipient payout. The Job Lock simultaneously validates the
committed executor reward, owner refund, one-shot termination, and Job Cell
capacity conservation. Thus campaign release and executor compensation either
both validate or neither does.

Unrelated executor-funded fee change is allowed. A second output to the success
recipient, a wrong recipient, changed terminal data, or capacity outside the two
campaign-authorized outputs is rejected.

## Verification Status

- Fixture-backed CKB-VM: verified for valid atomic settlement and mutations for
  early execution, under-target state, wrong success recipient, redirected
  executor reward, and an additional success-recipient output.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
