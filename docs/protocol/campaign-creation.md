# Demo Campaign Creation

The demo campaign type script recognizes creation only when its type group has
no inputs and exactly one output. The output data must be canonical
`CampaignDataV1`. Its 32-byte type-script args and `campaign_id` field must both
equal the domain-separated hash of input 0's previous outpoint and the campaign
output index. A CKB outpoint can be consumed only once, so this gives every
campaign a distinct type-script identity for later pledge and terminal
transitions without depending on the still-unknown creation transaction hash.

The campaign output uses the deployed zero-argument Campaign Lock. That lock
grants no owner-only authority; the campaign type script on the same input is
the authoritative transition guard. Any compatible executor can therefore
finalize the campaign, while the type script rejects an invalid value path.

Creation accepts only an open V1 campaign with:

- a non-zero target;
- a non-zero absolute block-number lower bound;
- a non-zero success recipient lock hash;
- a non-zero deterministic refund commitment; and
- consistent pledge total and pledge count presence.

The first transaction witness carries the canonical fixed-width pledge records
in `output_type`. The script requires exactly `pledge_count` records, strict
outpoint ordering, non-zero refund locks and amounts, a checked amount sum equal
to `pledged`, and an exact recomputation of `refund_commitment`.

The campaign cell's spendable capacity, calculated as total capacity minus its
exact occupied capacity, must equal `pledged`. Neither an underfunded aggregate
nor hidden unaccounted campaign value is valid. The refund commitment binds the
canonical pledge records whose checked amount sum and count produce the two
aggregate fields.

Any transaction outside the creation shape is rejected until its corresponding
state-transition rule is implemented. This prevents the creation validator from
acting as an accidental unrestricted update path.

## Verification Status

- Fixture-backed CKB-VM: a deterministic creation transaction passes with the
  compiled campaign type script. Mutations cover version, state, derived type identity,
  zero target, zero and wrong-metric deadlines, pledge count, success recipient,
  refund commitment and record mutation, and capacity one shannon below or above
  the commitment.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
