# Campaign Failure Finalization

Failure finalization consumes one open campaign and its one-shot deadline Job
Cell in the same transaction. It is valid only at the campaign's committed
absolute block deadline when `pledged < target`; equality belongs to the
success path.

## Committed Refunds

The campaign input-group witness reveals the canonical fixed-width pledge
records in `input_type`. The campaign script re-hashes those records against
`refund_commitment` and verifies their count and checked sum against the
committed campaign data.

One plain refund output is required for every record. Refund outputs must be
contiguous, immediately precede the campaign terminal output, and retain the
record order. Each has the exact committed full lock hash and amount, no type
script, and empty data. The terminal output changes only the state marker to
`REFUNDING`, preserves the campaign lock and all other data, and carries only
its occupied capacity. Together, the refunds and terminal cell exactly consume
the campaign input capacity.

The transaction may not also create an uncommitted output to the success
recipient. If a committed refund recipient happens to equal that recipient,
only the corresponding committed refund output is accepted. The deadline
policy independently requires one `REFUNDING` successor for the campaign type,
while the Job Lock validates the executor reward, owner residual, and absence
of a Job Cell successor.

## Verification Status

- Fixture-backed CKB-VM: verified for a valid permissionless refund and
  mutations covering target equality, state, refund commitment, recipient,
  amount, record order, and a mixed success/refund attempt.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
