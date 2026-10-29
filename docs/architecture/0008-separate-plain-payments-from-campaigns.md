# ADR 0008: Separate Plain Payments from Campaigns

- Status: Accepted
- Date: 2026-10-29
- Scope: One-time scheduled payment protocol

## Context

The current deadline workflow predates the payment-focused product. It uses a
campaign cell because it demonstrates two objective outcomes at one deadline:
pay the recipient when the committed target is met, or return the committed
amount to the refund address when it is not. That behavior is useful for the
testnet conditional-outcome flow, but its pledge records, target accounting,
campaign state, and terminal marker are unnecessary for a direct payment that
always transfers one amount at one scheduled time.

Treating the campaign contract as the permanent scheduled-payment abstraction
would increase transaction size, review complexity, indexing state, and the
number of scripts that must be composed and audited.

## Decision

Keep existing campaign-backed deadline jobs readable and executable under
their current V1 rules. Describe them as conditional deadline jobs rather than
as the long-term plain-payment protocol.

A direct scheduled payment must use a separate policy boundary. Its committed
terms are limited to the owner/refund lock, recipient lock, amount, schedule,
executor reward, and finite recovery behavior. It must not depend on campaign
pledges, a success target, campaign state, refund records, or a campaign
terminal marker.

New integrations must not use `demo-campaign-type` or `campaign-lock` as a
generic payment API. Moving the public creation flow requires a separately
deployed policy and an explicit compatibility release; changing the meaning of
the deployed V1 scripts in place is forbidden.

## Alternatives considered

- Reinterpret the existing campaign fields as payment fields. This would keep
  the same transaction shape but preserve the unnecessary state and make the
  protocol names misleading.
- Replace the deployed deadline policy in place. Data-hash scripts are immutable,
  existing jobs commit the current policy identity, and silent replacement would
  break compatibility and review assumptions.
- Remove campaign-backed jobs immediately. This would make existing testnet jobs
  unreadable or unexecutable and is not an acceptable migration.

## Consequences

- Existing conditional deadline jobs remain compatible.
- Direct scheduled payments get a smaller, independently auditable contract
  surface when their policy is deployed.
- The API and UI must identify the policy kind from chain data and support both
  forms during migration.
- A future deployment must include contract tests, SDK construction, executor
  reconstruction, indexing, owner recovery, and wallet review for the new policy
  before creation is enabled.

## Reversal cost

Reusing campaign machinery for new direct payments would require a superseding
ADR and evidence that the extra state is necessary. It must not be done only to
avoid a deployment or migration.
