# DAO Harvest V3

DAO Harvest V3 is the corrected, testnet-only protocol revision for automated Nervos DAO
compensation harvesting. It does not reinterpret or migrate V2 cells. Every V3 position is created
under new policy, vault-lock, and compensation-lock code hashes and V3 domain-separated
commitments.

## Safety invariants

- The principal capacity is immutable and is never used for service payments or network fees.
- A deposited DAO vault can only become a same-capacity withdrawing DAO cell at the same full
  transaction index.
- Owner operations require a separate input whose full lock-script hash matches the committed
  owner.
- Owner exit pays no service fee. Owner completion and recovery pay no claim fee; a previously
  earned prepare fee may be settled only to its committed accumulator.
- Every terminating operation consumes the Job, vault, and compensation state together. It cannot
  leave a live custom vault without its controlling Job.
- The final automated cycle creates an ordinary owner-locked DAO deposit. It creates no successor
  Job or CKAutomata vault.
- Network fees come from an owner or executor funding input, or from compensation explicitly left
  after principal and bounded service payments. They never reduce principal.

## Versioned scripts

V3 uses new `dao-harvest-job-lock-v3`, `dao-harvest-policy-v3`,
`harvest-vault-lock-v3`, and `compensation-lock-v3` binaries. A new Job Lock is required because
the harvest Job Lock decodes the versioned witness and operation number; reusing V2 would silently
reinterpret operation `9` and reject operation `10`. V2 manifests and binaries remain separately
addressable.

## States and operations

| Code | Operation | Input state | Authority | Result |
| ---: | --- | --- | --- | --- |
| 0 | Setup | none | owner | Job, deposited DAO vault, compensation state |
| 1 | Preferred prepare | deposited | preferred operator | withdrawing vault and prepare credit |
| 2 | Fallback prepare | deposited | approved fallback | withdrawing vault and prepare credit |
| 3 | Preferred claim | withdrawing | credited preparer | next deposited cycle |
| 4 | Fallback claim | withdrawing | fallback executor | next deposited cycle |
| 5 | Owner completion | withdrawing | owner | next deposited cycle, no claim fee |
| 6 | Sweep | active | owner | active state preserved; excess compensation paid |
| 7 | Close | terminal | owner | compensation state terminated |
| 8 | Rotate | active | owner | only operator commitments change |
| 9 | Owner exit | deposited | owner | owner-locked withdrawing DAO cell; automation terminated |
| 10 | Owner recovery | withdrawing | owner | mature DAO value returned; automation terminated |

Every other code and every state/operation mismatch is rejected.

## Owner exit layout

The owner-exit witness carries transaction-global indices. The Job, deposited vault,
compensation cell, and owner-identity input are mandatory. The withdrawing output index must equal
the deposited vault input index. That output has the exact committed principal, the canonical DAO
type, the owner's ordinary lock, and the deposit block number required by the Nervos DAO script.
There is no successor Job, custom vault, or compensation cell and no executor accumulator output.
Wallet funding and change may be present, but cannot change any committed index or output.

## Mature owner recovery layout

Owner recovery consumes a Withdrawing Job, mature DAO vault, compensation state, owner identity,
and optionally the credited prepare accumulator. It terminates all custom state. The owner receives
the Job capacity, canonical maximum DAO withdrawal, reserve, and remaining compensation. Only the
already-earned bounded prepare payment may be added to its committed accumulator. Claim payment is
zero. The DAO header indices, absolute epoch `since`, input data, and maximum withdrawal are
validated against the real Nervos DAO script.

## Final automated cycle

On the last configured cycle, a valid claim settles bounded work and creates a new DAO deposit at
the principal capacity under the committed ordinary owner lock. Its DAO data is eight zero bytes.
No successor Job is created. The compensation state becomes terminal and can be closed by the
owner. This leaves the principal manageable by standard Nervos DAO tooling without CKAutomata.

## Compatibility

V2 cells remain governed by V2 scripts. A V2 position can use only operations accepted by its
deployed code. No V2 position becomes V3 without an explicit owner-reviewed transaction accepted
by V2. Indexers and clients must select behavior from the exact deployment manifest and code hash,
never from a mutable label.
