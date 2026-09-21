# Demo Campaign State V1

`CampaignDataV1` is the canonical state for the deadline showcase. Its Molecule
definition is [`campaign_v1.mol`](../../contracts/schemas/campaign_v1.mol), and
generated Rust and TypeScript bindings are checked into the repository.

## State

| Field               | Rule                                              |
| ------------------- | ------------------------------------------------- |
| `version`           | Must be `1`                                       |
| `state`             | `0` open, `1` succeeded, `2` refunding            |
| `campaign_id`       | Stable network-bound campaign identity            |
| `pledged`           | Exact sum of committed pledge records in shannons |
| `pledge_count`      | Exact number of committed pledge records          |
| `target`            | Non-zero success threshold in shannons            |
| `deadline_since`    | Non-zero absolute block-number `since` value      |
| `success_lock_hash` | Full script hash of the only success recipient    |
| `refund_commitment` | Hash of the canonical ordered pledge records      |

Each pledge record contains its source outpoint, full refund lock hash, and
amount. Records are ordered by transaction hash and output index before the
domain-separated refund commitment is calculated. `pledged` must equal their
checked sum and `pledge_count` must equal their count. This binds both aggregate
accounting and every eventual refund destination.

## Objective Outcome

The input campaign remains open until the transaction's consensus-checked
absolute block lower bound reaches `deadline_since`. At that boundary the only
two results are:

| Transaction-visible condition | Required marker   | Authorized value path     |
| ----------------------------- | ----------------- | ------------------------- |
| `pledged >= target`           | `SUCCEEDED` (`1`) | Fixed `success_lock_hash` |
| `pledged < target`            | `REFUNDING` (`2`) | Fixed `refund_commitment` |

The decision uses integers already committed in the consumed campaign cell.
The executor cannot supply an outcome, target, total, recipient, refund list,
wall-clock value, API response, approval, vote, evidence score, or oracle
claim. Later policy rules must recompute the branch from transaction inputs and
reject any terminal marker or output that disagrees.

## Verification Status

- Schema review checks exact field order, state markers, absolute-block timing,
  deterministic refund ordering, and the absence of subjective input fields.
- Rust and TypeScript codecs match one shared binary fixture.
- Boundary tests prove below-target, exactly-at-target, and above-target results,
  plus valid and invalid absolute block lower bounds.
- Creation and terminal transition rules are implemented in subsequent units;
  this unit defines their canonical state and decision function only.
