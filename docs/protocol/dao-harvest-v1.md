# DAO Harvest Protocol V1

Status: Draft implementation specification

Network: CKB testnet only

## Scope

DAO Harvest V1 coordinates a new vault-controlled Nervos DAO deposit through repeated prepare and
claim/redeposit transitions. It reuses `JobDataV1`, the Job Lock owner and execution modes, and the
generic policy payload commitment.

The canonical policy payload is `DaoHarvestPayloadV1` in
[`dao_harvest_v1.mol`](../../contracts/schemas/dao_harvest_v1.mol). The generated Rust and
TypeScript bindings and `dao_harvest_payload_v1.json` are checked representations of that source.

## Policy fields

| Field                        | Meaning                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `version`                    | Exact protocol version `1`                                                   |
| `owner_lock_hash`            | Full lock hash required on a distinct owner input                            |
| `payout_lock_hash`           | Only lock allowed to receive compensation                                    |
| `vault_lock_hash`            | Exact Harvest Vault Lock protecting the DAO cell                             |
| `dao_type_hash`              | Exact deployed Nervos DAO type script required on the protected cell         |
| `principal_capacity`         | Exact full capacity preserved through prepare and re-deposit                 |
| `prepare_executor_set_hash`  | Active commitment to 1 through 8 sorted, unique prepare executor lock hashes |
| `executor_reward`            | Exact Job-funded reward for each prepare or claim/redeposit action           |
| `min_compensation`           | Off-chain minimum used before prepare; it cannot block a prepared claim      |
| `prepare_buffer_epochs`      | Relative epoch duration before a boundary at which prepare opens             |
| `confirmation_margin_epochs` | Smaller relative epoch duration defining the operational prepare cutoff      |
| `total_cycles`               | Exact finite number of approved harvest cycles                               |
| `end_epoch_since`            | Optional absolute epoch end bound; zero means absent                         |

The payload hash is:

```text
H(
  "ckb-automata/policy-payload/v1",
  dao_harvest_policy_script_hash || molecule(DaoHarvestPayloadV1)
)
```

The prepare executor set hash is:

```text
H(
  "ckb-automata/dao-harvest-executors/v1",
  uint32_le(count) || sorted_unique_executor_lock_hashes
)
```

`H(domain, body)` is BLAKE2b-256 with CKB personalization `ckb-default-hash` over
`utf8(domain) || 0x00 || uint32_le(body_length) || body`.

## Mutable progress

Mutable progress does not belong in the policy payload:

| Source                               | Progress                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `JobDataV1.sequence`                 | Completed transition sequence                                              |
| `JobDataV1.remaining_runs`           | Remaining on-chain actions; setup uses exactly `total_cycles * 2`          |
| `JobDataV1.remaining_budget`         | Remaining Job-funded rewards                                               |
| `JobDataV1.not_before`               | Current absolute epoch lower bound                                         |
| `JobDataV1.not_after`                | Immutable optional automation end epoch                                    |
| `JobDataV1.trigger_params_hash`      | Commitment to the current lower bound                                      |
| Co-spent DAO cell data               | Eight zero bytes means deposited; a deposit block number means withdrawing |
| Canonical input outpoint and headers | Current DAO cell identity, deposit header, and phase-one header            |

Automated successors preserve `JobDataV1.payload_hash`. An owner rotation may replace it only with a
payload that changes `prepare_executor_set_hash`; all other fields and all mutable progress stay exact.
A changing DAO outpoint, state byte, boundary, or remaining-cycle counter must never be added to the payload.

## Operations

| Code | Operation      | Required authority                                                            |
| ---: | -------------- | ----------------------------------------------------------------------------- |
|  `0` | Prepare        | Job execution request plus approved executor input and set proof              |
|  `1` | Roll           | Job execution request plus executor input; no prepare-set membership required |
|  `2` | Owner stop     | Distinct co-spent owner input                                                 |
|  `3` | Owner exit     | Distinct co-spent owner input                                                 |
|  `4` | Owner recovery | Distinct co-spent owner input                                                 |

Owner operations reuse the Job Lock's existing cancel/recover authorization. The DAO Harvest Policy
and Harvest Vault Lock independently require the same committed owner lock hash when their cells are
spent through an owner path.

The owner may also rotate the approved prepare executors. This consumes and recreates only the Job
Cell, changes only `prepare_executor_set_hash`, preserves its capacity and progress, and leaves the
current Nervos DAO deposit or withdrawal untouched.

## Witness envelopes

### Job Lock group

The Job input uses the existing Job Lock `WitnessArgs.input_type` format:

```text
execute = 0x00
       || reward_output_index:u32_le
       || executor_lock_hash:byte32
       || controlled_output_count:u8
       || controlled_output_indices:u32_le[]

cancel  = 0x01
recover = 0x02
rotate_prepare_executors = 0x04 || successor_output_index:u32_le
```

The complete canonical `DaoHarvestPayloadV1` bytes are carried first in the policy group witness
`output_type` for setup and every later transition. During setup and prepare it is followed by the
executor-set proof: `count:u8 || sorted_unique_lock_hashes`. The policy reads the Molecule total
size, hashes only those payload bytes, then validates the proof. During roll and owner operations no
proof bytes follow the payload. Rotation carries the current payload, the replacement payload, and
the replacement executor-set proof in that order.

### Harvest Vault Lock group

The first vault-group witness uses `WitnessArgs.lock`. The DAO type script owns
`WitnessArgs.input_type`, including its deposit-header index during a claim:

```text
automation = 0x00
          || operation:u8                 # 0 prepare, 1 roll
          || job_input_index:u32_le

owner = 0x01 || operation:u8               # 2 stop, 3 exit, 4 recovery
```

Prepare executor hashes must be sorted and unique. The policy hashes the supplied set, compares it
to `prepare_executor_set_hash`, and requires the Job execution executor identity to be a member. The
executor proves control through its distinct co-spent lock input; an address or witness hash alone
is not authorization.

## Setup transaction

```text
Inputs
  owner-selected ordinary CKB cells

Outputs
  [vault] new Nervos DAO deposit
          lock = Harvest Vault Lock(
                   job_id,
                   owner_lock_hash,
                   job_lock_hash,
                   policy_script_hash,
                   immutable_terms_commitment
                 )
          type = deployed Nervos DAO type
          data = eight zero bytes
          capacity = principal_capacity
  [job]   funded Job Cell
          lock = Job Lock
          type = DAO Harvest Policy
          data = JobDataV1
  [...]   ordinary owner change

Witness
  owner wallet signature
  output_type = canonical DaoHarvestPayloadV1 plus the sorted executor-set proof
```

Setup requires `sequence = 0`, `remaining_runs = total_cycles * 2`, reward equal to
`executor_reward`, the first exact epoch lower bound in `not_before`, the immutable optional end
epoch in `not_after`, and enough Job Cell spendable capacity for every approved action reward.

The final 32 bytes of the 160-byte vault-lock arguments commit, under the
`ckb-automata/dao-harvest-vault-commitment/v1` domain, to every immutable economic term except the
vault lock hash itself and the separately owner-rotatable executor-set hash. The commitment covers
the owner, compensation payout, DAO type, principal, reward, compensation preference, timing
parameters, cycle count, and end epoch. Both the vault lock and policy recompute it from the payload
on every automated vault spend. A copied Job Cell therefore cannot use the real vault with a
different payout or other economic terms. Normal prepare successors must also preserve the exact
input payload hash; executor rotation remains a distinct owner-authorized operation.

## Prepare transaction

```text
Inputs
  vault DAO deposit
  matching live Job Cell
  approved executor fee/identity cells

Header deps
  original deposit block header

Outputs
  [same DAO group index] withdrawing DAO cell
          same capacity, vault lock, DAO type
          data = original deposit block number
  exact per-action executor reward to the executing identity
  one successor Job Cell
  executor change
```

The Job successor keeps the committed payload hash and reward, advances the sequence, decrements
remaining actions, commits the exact mature claim epoch in `not_before`, preserves `not_after`, and
reduces the funded budget by exactly `executor_reward`.

The on-chain lower bound prevents early preparation. `not_after` is not an on-chain expiry and must
not be presented as one.

## Claim, harvest, and re-deposit transaction

```text
Inputs
  vault DAO withdrawing cell
  matching live Job Cell
  executor fee/identity cells

Header deps
  original deposit block header
  confirmed prepare inclusion header

Input since
  exact mature absolute claim epoch required by the DAO script

Outputs
  new vault DAO deposit with exactly principal_capacity and eight zero data bytes
  exact gross compensation to payout_lock_hash
  exact per-action executor reward to the executing identity
  exactly one successor Job Cell when another cycle remains
  executor change
```

When another cycle remains, the successor keeps the committed payload and reward, decreases
`remaining_runs` by one, commits the next exact preparation lower bound, preserves the immutable end
epoch, and reduces the budget by exactly `executor_reward`. The final cycle creates no successor
Job Cell. The owner may instead select the owner-exit path, which creates no executor reward or
recurring successor.

## Error identities

DAO Harvest V1 reserves script codes `36` through `42` for invalid DAO cell association, changed
principal, changed payout, unauthorized prepare executor, compensation below minimum, cycle-limit
violation, and invalid executor set. Generic Job errors remain authoritative for malformed data,
owner authorization, policy and payload commitments, sequence, trigger, reward, conservation, and
successor failures.

## Security boundary

The complete accepted authority, residual timing trust, recovery requirements, and testnet release
criteria are normative in
[`dao-harvest-scope-and-threat-model.md`](./dao-harvest-scope-and-threat-model.md).
