# CKB Automata

> Permissionless, policy-constrained execution for CKB applications.

**Document type:** Full project and product specification  
**Research snapshot:** 21 September 2026  
**Project status:** Research and validation; no production deployment or security review  
**Reference integration families:** deadline finalization, recurring distribution, and multi-stage maturity  
**Summary:** [CKB_AUTOMATA_SUMMARY.md](./CKB_AUTOMATA_SUMMARY.md)  
**Companion brief:** [`ckb-automata.md`](./ckb-automata.md)

---

## 1. Executive Summary

CKB Automata is a non-custodial execution protocol for actions that become valid later but still
need an off-chain actor to construct and submit a transaction. CKB scripts can verify a state
transition, including time constraints and value conservation, but they do not wake themselves,
query an indexer, build a transaction, retry it, or pay an operator. Every application with a
deadline, expiry, recurring payment, claim, refund, or maintenance action therefore needs a
keeper-like process.

Automata standardizes that process around four ideas:

1. A funded **Job Cell** records a narrow action policy, trigger, reward, status, and recurrence.
2. A policy-specific lock or type script limits exactly what an executor may do.
3. Permissionless executors discover eligible jobs, simulate transactions, submit them, and retry
   safely where the policy is safe under late execution. Policies with harmful upper time bounds
   may restrict the sensitive transition to a user-approved executor set.
4. The action, executor reward, and optional successor job settle atomically on CKB.

The first release should not be selected around one suggested application. It should prove that the
same Job Cell lifecycle works across at least two automation families: **deadline finalization**
and **recurring distribution**. CKB Kickstarter and CCC Schedule Send already demonstrate those
operational needs in separate application-specific services. A third, more demanding reference
workflow can test multi-stage maturity, state predicates, or human-approved continuation.

Nervos DAO cycle management remains one well-researched candidate, with two proposed features:

- **Cycle Guard:** notify a user before the ideal phase-one withdrawal window and, when the wallet
  permits it, hold a pre-approved phase-one transaction for later broadcast.
- **Harvest Compensation:** after one explicit setup approval, a user-approved executor prepares a
  DAO withdrawal near the next 180-epoch boundary; after maturity, any valid executor can claim it,
  send the compensation to the user's chosen address, and atomically redeposit the configured
  principal for another cycle.

These are reference designs, not the predetermined product roadmap. They proceed only if NervDAO
maintainers and users validate demand, the integration is accepted, and measured economics justify
the additional policy risk. Harvest Compensation is a cash-flow feature, not a yield booster.
Nervos DAO already calculates compensation from the accumulated-rate ratio and effectively
compounds it while a deposit remains in the DAO. Harvesting makes accrued compensation liquid at a
chosen cadence, but introduces transaction fees, executor rewards, and a short period in which the
principal is prepared for withdrawal and no longer accruing compensation.

The full DAO recurring flow cannot safely be implemented as two ordinary transactions signed weeks in
advance. The second transaction depends on the block that includes the first withdrawal-preparation
transaction. A production implementation therefore needs a constrained automation vault lock, or
another audited policy-authorization mechanism, rather than a hosted service holding the user's
general private key.

## 2. Research Conclusions

### 2.1 Confirmed protocol facts

- A Nervos DAO withdrawal has two phases: a deposit cell becomes a withdrawing cell, then the
  withdrawing cell is claimed after the applicable 180-epoch boundary.
- A DAO cycle is 180 epochs. With CKB's target of four hours per epoch, this is approximately 30
  days, but scheduling must use epoch numbers and fractions rather than calendar time.
- Phase one may be submitted at any time, but compensation stops at the block that includes phase
  one. Preparing close to the end of a cycle therefore retains more compensation.
- Phase two needs the deposit block header, the phase-one inclusion block header, an absolute
  epoch `since`, and the witness index of the deposit header.
- The maximum withdrawable amount is derived from the deposit and withdrawal accumulated rates:

  ```text
  maximum_withdraw =
    (total_capacity - occupied_capacity) * AR_withdraw / AR_deposit
    + occupied_capacity
  ```

- A transaction can mix DAO actions. This makes it possible for the phase-two transaction to
  claim one withdrawing cell, pay out compensation, and create a new DAO deposit atomically.
- The DAO script is a type script. The cell's lock script still controls authorization, so a
  purpose-built lock can authorize only the narrowly defined harvest transitions.
- CKB `since` is a not-before condition. It does not make a transaction invalid after a later
  deadline. A pure script cannot prove that phase one was included before an ideal cycle boundary
  merely from a committed `not_after` value.

The normative source is [Nervos RFC 23: Deposit and Withdraw in Nervos
DAO](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md).
The deployed behavior must also be checked against the target network's
[DAO system script](https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/dao.c).

### 2.2 Correction to the proposed return language

The phrase "harvest roughly 2% compensation monthly" is misleading. The percentage is not a fixed
monthly payment. Nervos DAO offsets secondary-issuance dilution, and its rate changes as the chain's
issuance and total supply evolve.

At mainnet block `20,521,318`, observed at `2026-09-21T13:41:06Z`, the simple 365-day annualization
of the change in the `AR` field over the preceding 75,600 blocks was approximately **2.05% per
year**. This is a point-in-time rate estimate using the same short-window, non-compounded
annualization approach present in NervDAO's current frontend; it is not a guaranteed APY. A
compounded annualization of the same interval would produce a different number. Exact compensation
for a deposit must always be computed from its actual deposit and phase-one headers.

The product wording should be:

> Harvest accrued Nervos DAO compensation near each eligible cycle while automatically
> redepositing the configured principal.

### 2.3 Current NervDAO behavior

The current [NervDAO repository](https://github.com/ckb-devrel/nervdao) was inspected at commit
`f3eec6581cf26838725f84bd42256a5ea8957cb4` dated 19 September 2026.

Its direct DAO flow currently:

- constructs a phase-one transaction using the deposit header;
- calls the connected CCC signer to sign and send it;
- later constructs phase two using both deposit and phase-one headers; and
- calls the connected signer again.

This is correct for user-driven withdrawal, but it confirms that hands-off recurring harvesting is
not a frontend-only enhancement. The present code has no durable job, policy vault, executor
reward, or permissionless retry protocol.

The NervDAO README also states that DAO compensation already compounds without monthly withdrawal.
Automata must not market harvesting as required for compounding.

### 2.4 Why two ordinary pre-signed transactions are insufficient

An ordinary CKB signature commits to the transaction, including its raw transaction hash and the
relevant witnesses. The raw transaction includes `header_deps`. Although the phase-one transaction
can be constructed after the original deposit is confirmed and delayed with an absolute `since`,
phase two needs the header of the block that eventually includes phase one. That block is unknown
when the user first approves the schedule.

Therefore:

| Mode | One initial approval | Fully automatic | New on-chain script | Security character |
|---|---:|---:|---:|---|
| Reminder only | Yes | No | No | Lowest change; user signs both phases |
| Pre-signed phase one | Yes | Partly | No | Automates preparation; user still signs claim |
| Hosted hot key | Yes | Yes | No | Custodial or broadly delegated; not recommended |
| Constrained vault lock | Yes | Yes | Yes | Non-custodial; V1 phase one still uses an approved executor set |

If NervDAO is selected as a design partner, its recommended product path is to ship Reminder/Cycle
Guard before treating the constrained vault as a separately reviewed protocol release. This does
not determine Automata's first cross-application integration.

### 2.5 The upper-bound timing limitation

This limitation changes the trust model for DAO harvesting. `since` can stop phase one from being
included too early, but no native inverse of `since` makes the same transaction expire at the end
of the preparation window. If any address may use the vault's automation path forever, a malicious
actor could wait until just after the boundary, prepare the withdrawal, stop compensation accrual,
and force the principal to wait until the following cycle. The actor could grief the user without
stealing funds.

V1 therefore separates executor policy by transition:

- **DAO phase one:** only identities in a user-approved executor set may use the automation path.
  Use at least two independent operators for availability. A compromised operator can mistime the
  action but cannot redirect principal, compensation, or rewards beyond the policy.
- **DAO phase two/redeposit:** may be permissionless because executing the fixed valid transition
  sooner is beneficial and all outputs are fully constrained.
- **Monotonic deadline jobs:** may be permissionless when executing later remains safe, such as an
  already-expired refund.
- **Future permissionless windowed mode:** requires a credible freshness proof, bonded/slashable
  execution, or protocol support that makes late execution invalid. It is not part of V1.

An application-level `not_after` remains useful for scheduling and UI, but it must never be called
consensus-enforced unless the policy identifies the exact on-chain freshness proof.

### 2.6 Evidence status

| Claim or artifact | Status on 21 September 2026 |
|---|---|
| DAO two-phase flow, formula, and 180-epoch rule | Confirmed from active RFC and system-script source |
| NervDAO currently requests wallet signatures for both phases | Confirmed from repository source at pinned commit |
| CCC provides DAO profit and claim-epoch helpers | Confirmed from repository source at pinned commit |
| Mainnet AR snapshot and annualized estimate | Live read-only RPC verification; no transaction sent |
| Atomic claim plus new DAO deposit | Supported by RFC transaction composition; custom policy not yet prototyped |
| Harvest Vault Lock security | Design only; unimplemented and unaudited |
| Preparation-window reliability and break-even amount | Unknown until measured on testnet and shadow mode |
| NervDAO maintainer demand and upstream acceptance | Unverified; requires direct maintainer validation |
| Permissionless upper-bound timing | Not supported by native `since`; excluded from V1 |

Application research elsewhere in this document is evidence of repeated automation work, not proof
that those applications have committed to Automata. Deployment status, security maturity, and
technical compatibility are reported separately in Section 10.

No live funds were moved during this research. The document distinguishes confirmed protocol and
source facts from proposed behavior that still requires implementation, testnet evidence, and an
independent security review.

## 3. Vision, Goals, and Boundaries

### 3.1 Vision

CKB applications should be able to buy liveness without giving an operator custody. A developer
should describe a verifiable future action, fund its execution, and rely on any compatible executor
to perform it once valid.

### 3.2 Product goals

- Remove bespoke cron, hot-key, retry, and monitoring services from CKB applications.
- Make automation intent visible and auditable on-chain.
- Keep action authority narrow enough that an executor cannot redirect principal or expand scope.
- Let multiple executors compete without enabling duplicate state transitions or reward theft.
- Support policy-scoped executor sets when late execution can cause harm that CKB cannot natively
  reject.
- Support deterministic one-shot and recurring jobs.
- Provide first-class simulation, receipts, failure classification, and recovery.
- Integrate through CCC and existing CKB indexing infrastructure.
- Prove demand through real application integrations before proposing a large ecosystem grant.

### 3.3 Non-goals

- Custodying user seed phrases, private keys, wallet sessions, or unrestricted session keys.
- Scheduling arbitrary transactions from a normal wallet.
- Promising a fixed DAO return or increasing the Nervos DAO protocol rate.
- Building a general oracle network in V1.
- Supporting arbitrary HTTP events as trustless triggers.
- Cross-chain automation in V1.
- Fiber channel management in V1.
- A protocol token, staking market, slashing system, or governance DAO.
- Replacing application-specific business logic.
- Mainnet operation before an independent script audit and sustained testnet evidence.

### 3.4 Product principles

1. **Policy before execution.** On-chain rules define the executor's authority.
2. **No general key.** Executors never receive a user's ordinary signing capability.
3. **Atomic payment.** The executor earns a reward only when the intended action succeeds.
4. **Small policies.** Each action class gets a bounded validator rather than a universal VM.
5. **Chain-derived time.** Eligibility uses `since`, headers, and epoch fractions, not a server
   clock.
6. **Observable failure.** Every retry and terminal state has a machine-readable reason.
7. **Owner escape.** A user retains a documented, tested cancellation or recovery path.
8. **No hidden yield claims.** Fees, downtime, and opportunity costs are shown before approval.

### 3.5 Integration precondition

Automata can execute only a transition that the application's current scripts already permit
without an owner's ordinary signature, or a transition placed under a new narrowly constrained
policy approved by that owner. It cannot autonomously spend a standard signature-locked cell,
convert an indexer observation into on-chain proof, or bypass an application's approval rules.

Before an application is called an integration candidate, its maintainers must identify the exact
cells, lock/type scripts, trigger evidence, output constraints, cancellation path, and executor
funding source. If the workflow still requires a general hot key or subjective off-chain decision,
it is not a non-custodial Automata job yet.

## 4. Users and Jobs to Be Done

| Persona | Job to be done | Current pain | Automata outcome |
|---|---|---|---|
| CKB application developer | Execute deadlines reliably | Bespoke keeper, hot key, retries, monitoring | Publish a funded constrained job |
| DAO or grant operator | Release scheduled tranches | Manual signing calendar and operational key | Auditable recurring distribution |
| Marketplace operator | Close auctions or expire orders | Central backend is a liveness dependency | Permissionless finalization |
| Executor operator | Earn for useful chain work | No common job format or discovery protocol | Standard job stream and deterministic reward |
| Auditor/integrator | Understand delegated authority | Custom bot behavior is off-chain and opaque | Explicit policy, schema, test vectors, receipts |
| DAO depositor | Act near the right withdrawal boundary | Missed cycle can mean another roughly 30-day wait | Alerts or constrained automatic execution |
| Income-oriented holder | Make compensation liquid periodically | Two transactions, timing, and repeated wallet approval | Principal is rolled; compensation is delivered |

## 5. Product Surfaces

CKB Automata consists of seven product surfaces.

### 5.1 Job protocol

A versioned Molecule schema describes identity, sequence, trigger, policy, payload commitment,
reward, budget, cancellation, scheduling metadata, and recurrence. Expiry is enforceable only when
the action policy supplies a verifiable upper-bound condition.

### 5.2 Policy scripts

Small lock or type scripts validate a specific transition. A policy validates outputs and value
flow; the general Job script validates lifecycle, trigger, sequence, and reward.

### 5.3 Executor

An open-source daemon indexes jobs, evaluates eligibility, calls an adapter, simulates the result,
submits transactions, tracks confirmation, and retries after conflicts or reorgs.

### 5.4 TypeScript SDK

The SDK creates and inspects jobs, calculates occupied capacity, builds cancellation transactions,
registers adapters, estimates rewards, and decodes receipts. CCC should be the primary transaction
and wallet integration layer.

### 5.5 Adapter kit

An adapter constructs the application-specific part of a transaction. Adapters are deterministic,
versioned, and testable without running a hosted service.

### 5.6 Index and API

The index service exposes a convenient read model. It is not authoritative; every returned state
can be verified against CKB.

### 5.7 Console and embedded UI

The console is an inspection and operations surface. Application users should normally interact
through an embedded integration in their existing CKB application.

## 6. Nervos DAO Primer for the Product

This section preserves the detailed DAO research because it is useful for one candidate adapter.
It does not establish NervDAO as the first integration or make DAO-specific fields part of the
generic Job Cell protocol.

### 6.1 Deposit

A DAO deposit output:

- uses the Nervos DAO type script;
- contains eight zero bytes as data; and
- uses a lock that authorizes later consumption.

Only the capacity not occupied by the cell's serialized fields receives compensation. The SDK must
calculate occupied capacity for the exact lock and type script rather than relying on a hard-coded
minimum deposit.

### 6.2 Prepare withdrawal: phase one

Phase one consumes the deposit cell and creates a withdrawing cell at the same output index. The
output keeps the same capacity and DAO type script, while its eight-byte data field stores the
original deposit block number. The transaction includes the deposit block header.

Compensation is fixed at the phase-one inclusion block. Preparing too early reduces compensation;
preparing after the desired boundary moves the claim to the next cycle.

### 6.3 Claim: phase two

Phase two consumes the withdrawing cell. It includes:

- the phase-one inclusion header;
- the original deposit header;
- the deposit-header index in `WitnessArgs.input_type`; and
- the calculated absolute epoch `since` value.

After the `since` requirement is met, the transaction may create ordinary CKB outputs, another DAO
deposit, or both, subject to all lock and DAO checks.

### 6.4 Scheduling implication

The automation target is not "run every 30 calendar days." It is:

1. Derive the next eligible boundary from the deposit epoch number and fraction.
2. Open a preparation window before that boundary.
3. Get phase one confirmed inside the window with enough margin for proposal/commit and reorg risk.
4. Derive the exact claim epoch from the confirmed phase-one header.
5. Claim and redeposit after maturity.

Step 3 is an operational obligation of the approved phase-one executors. The input `since` can
enforce the start of the window, but CKB cannot natively enforce its end.

## 7. Candidate Low-Risk Product: DAO Cycle Guard

Cycle Guard is the lowest-risk NervDAO candidate and should precede autonomous custody policy work
if NervDAO is selected as a design partner. It does not take priority over a committed external
deadline or distribution integration merely because its design is more detailed here.

### 7.1 User value

- Shows the next boundary using epoch-aware calculations.
- Warns when preparing now would push the user into another cycle.
- Sends opt-in notifications before the recommended preparation window.
- Builds the phase-one transaction with an explicit not-before condition where the selected lock
  and wallet support it.
- Lets the user pre-sign phase one for scheduled broadcast.
- Tracks confirmation, maturity, and the remaining manual phase-two action.

### 7.2 Limitations

- Pre-signing support varies by wallet and lock implementation.
- The user must not spend the selected DAO deposit before broadcast.
- Fee inputs included in the signed transaction must remain live.
- A fee chosen weeks earlier may become unattractive to relays.
- Phase two still needs a later signature because its phase-one header is not known in advance.

### 7.3 Acceptance criteria

- The displayed claim boundary matches CCC's `calcDaoClaimEpoch` for published fixtures.
- The service never broadcasts before the signed `since` requirement.
- A stale or consumed input becomes `CONFLICTED`, not a repeated failing broadcast loop.
- The UI distinguishes "scheduled to prepare" from "CKB ready to claim."
- Notification delivery failure never changes on-chain state.

## 8. Advanced Reference Workflow: Harvest Compensation

### 8.1 User promise

The user chooses a principal amount, payout address, cycle count or end epoch, preparation safety
margin, and maximum executor reward. After one setup transaction:

1. The principal remains deposited in Nervos DAO for most of each cycle.
2. An executor prepares withdrawal shortly before the target boundary.
3. Another executor claims after maturity.
4. The configured principal is deposited back into Nervos DAO in the same transaction.
5. Accrued compensation is sent to the payout address; separately pre-funded job rewards pay the
   executors.
6. A successor job repeats the process until the cycle limit, expiry, budget limit, or owner
   cancellation is reached.

### 8.2 What the feature does not promise

- It does not create a fixed or guaranteed yield.
- It does not improve the DAO compensation rate.
- It does not avoid all time out of the DAO; compensation stops at phase one and resumes when the
  new deposit confirms.
- It does not make the principal liquid during a cycle.
- It does not protect against a bug in the vault lock or policy script.
- It does not guarantee execution when the funded reward is uneconomic.

### 8.3 User-configurable policy

| Parameter | Meaning | Required constraint |
|---|---|---|
| `owner_lock_hash` | Emergency and cancellation authority | Immutable |
| `payout_lock` | Receives harvested compensation | Immutable or owner-changeable only |
| `principal_capacity` | Capacity that must be redeposited | Exact, not merely a minimum |
| `prepare_buffer_epochs` | Desired margin before boundary | Bounded safe range |
| `prepare_executor_set_hash` | Identities allowed to initiate phase one | Immutable in V1 |
| `max_cycles` | Maximum recurring executions | Finite for V1 |
| `end_epoch` | Optional hard stop | Cannot be extended by executor |
| `prepare_reward` | Reward for phase one | Fixed and pre-funded |
| `roll_reward` | Reward for phase two/redeposit | Fixed and pre-funded |
| `min_payout` | Skip harvest if projected economic net benefit is too small | Protects user economics |
| `confirmation_depth` | Application finality policy | Bounded operator setting |
| `version` | Vault and job behavior | Immutable for a live cycle |

### 8.4 On-chain objects

#### Harvest Vault DAO Cell

The principal is held in a Nervos DAO cell using the Harvest Vault Lock. The lock has two paths:

- **Owner path:** a valid owner signature may stop automation, change destination through an
  explicitly permitted recovery transaction, or perform a normal DAO withdrawal.
- **Automation path:** no owner signature is needed, but the transaction must match the exact
  phase-one or phase-two/redeposit transition and must consume the matching Job Cell. Phase one
  additionally requires an identity from the approved executor set; phase two may be permissionless.

#### Harvest Job Cell

The Job Cell stores or commits to:

```text
version
job_id
sequence
state
vault_lock_hash
owner_lock_hash
payout_lock_hash
principal_capacity
deposit_out_point_or_vault_id
deposit_epoch
target_boundary
prepare_buffer_epochs
prepare_executor_set_hash
prepare_reward
roll_reward
remaining_cycles
end_epoch
min_payout
policy_hash
payload_hash
```

Where practical, large or repeated script data should be committed by hash to minimize occupied
capacity. The canonical schema must define byte order, optional fields, and hashing domain.

### 8.5 Harvest state machine

```text
                         owner signed
                      +-----------------> CANCELLED
                      |
SETUP -> DEPOSITED -> PREPARE_READY -> PREPARE_SUBMITTED -> WITHDRAWING
  |          |                |                 |               |
  |          |                |                 |               v
  |          |                |                 |          CLAIM_READY
  |          |                |                 |               |
  |          |                |                 |               v
  |          |                |                 +--------- ROLL_SUBMITTED
  |          |                |                                 |
  |          |                |                                 v
  |          +<---------------+-------------------------- REDEPOSITED
  |                                                            |
  +------------------------------------------------------------+
                    sequence + 1 while cycles remain

Any live state -> RECOVERY_REQUIRED
Terminal states: COMPLETED, CANCELLED, EXPIRED, BUDGET_EXHAUSTED
```

`SUBMITTED` and time-derived `EXPIRED` are executor/index states, not necessarily distinct on-chain
cell states. The protocol specification must say which states are authoritative on-chain and which
are derived.

### 8.6 Setup transaction

For ordinary CKB, the user signs one setup transaction that:

- creates a new DAO deposit protected by Harvest Vault Lock;
- creates a funded Harvest Job Cell;
- commits owner, payout, reward, expiry, and recurrence constraints; and
- returns all unrelated change to the user's ordinary lock.

An existing standard-lock DAO deposit cannot be treated as ordinary CKB in this setup flow. It
needs a separate, owner-signed migration path that respects the DAO's current phase, header
dependencies, lock-size rules, and claim timing. V1 may reasonably support only new deposits until
that migration path has its own specification and tests.

The UI must show the exact worst-case authority being granted. "Automate" is insufficient consent
language. The confirmation should state that the vault can prepare, claim, pay capped rewards,
redeposit exactly the principal, and send only compensation to the configured recipient.

### 8.7 Phase-one transaction: prepare near boundary

Required structure:

```text
Inputs
  [0] DAO deposit protected by Harvest Vault Lock
  [1] Harvest Job Cell in DEPOSITED/PREPARE_READY state
  [...] executor fee inputs

Header deps
  original deposit block header

Witness
  approved phase-one executor identity and signature
  membership proof when the committed set uses a Merkle/SMT root

Outputs
  [0] DAO withdrawing cell with same capacity, type, and serialized lock size
  [1] Harvest Job Cell in WITHDRAWING state
  [2] fixed prepare reward to the bound executor identity
  [...] executor change
```

The scripts must validate:

- output 0 is the correct DAO withdrawing cell at the required index;
- the principal capacity is unchanged;
- the vault policy remains unchanged;
- the input carries the required not-before `since` value;
- the executor identity belongs to the approved phase-one executor set;
- the successor job commits to the actual withdrawing cell or stable vault identity;
- only the fixed reward is paid; and
- no payout or principal extraction occurs in phase one.

### 8.8 Phase-two transaction: claim, harvest, and redeposit

Required structure:

```text
Inputs
  [0] DAO withdrawing cell protected by Harvest Vault Lock
  [1] matching Harvest Job Cell in WITHDRAWING/CLAIM_READY state
  [...] executor fee inputs

Header deps
  phase-one inclusion block header
  original deposit block header

Input since
  exact or conservative absolute claim epoch

Witness
  deposit header index for the DAO type script
  executor identity/commitment for reward protection

Outputs
  [0] new DAO deposit with exactly principal_capacity and the same vault policy
  [1] harvested compensation to payout_lock
  [2] fixed roll reward to the executor
  [3] successor Job Cell with sequence + 1, if recurrence continues
  [...] executor change
```

The new DAO deposit uses eight zero bytes. Keep vault and job accounting separate:

```text
gross_compensation = maximum_withdraw - principal_capacity
harvest_payout     = gross_compensation - explicitly_permitted_protocol_fee

remaining_job_budget = previous_job_budget - roll_reward
```

The prepare reward was already paid from the pre-funded Job Cell during phase one. The roll reward
is paid from the remaining Job Cell budget during phase two. Network fees should be paid by
executor inputs and economically covered by the posted rewards. Do not silently reduce principal
or harvested compensation to pay a network fee. If a future policy permits a protocol fee to be
deducted from compensation, the maximum deduction must be explicit and independently bounded.

### 8.9 Recurrence

A successful roll creates exactly one successor job with:

- the same `job_id`;
- `sequence + 1`;
- the same owner, payout, principal, and policy hashes;
- `remaining_cycles - 1`;
- the new deposit reference and epoch; and
- enough remaining budget and occupied capacity.

No successor is allowed when the end epoch has passed, remaining cycles is zero, the reward budget
is insufficient, or the owner selected "harvest once."

### 8.10 Scheduling algorithm

The scheduler operates on exact rational epoch positions.

```text
deposit_position = deposit_epoch_number
                 + deposit_epoch_index / deposit_epoch_length

next_boundary = deposit_position + 180 * k
where k is the smallest positive integer whose boundary is after the tip

prepare_start = next_boundary - configured_buffer
prepare_deadline = next_boundary - minimum_confirmation_margin
```

Executor behavior:

1. Before `prepare_start`, classify the job as `NOT_YET_ELIGIBLE`.
2. In the preparation window, build and simulate phase one.
3. Stop submitting at the deadline if inclusion before the boundary is no longer credible.
4. If the boundary is missed, recompute for the next 180-epoch cycle; do not prepare immediately
   after the missed boundary unless the policy expressly permits sacrificing a cycle's accrual.
5. After phase one confirms to the configured depth, derive the claim epoch using the confirmed
   header and construct phase two.
6. Submit phase two only when its `since` is mature.

The default buffer must be determined empirically on testnet and then mainnet shadow mode. A large
buffer improves inclusion probability but increases compensation lost while withdrawing. This is
an explicit reliability/economic tradeoff, not a hidden implementation constant. The phase-one
transaction does not expire on-chain at `prepare_deadline`; approved operators must stop submitting
it, remove it from local retry queues, and alert if it remains pending. The residual risk that an
approved operator deliberately broadcasts late must be shown in the user consent flow.

### 8.11 Illustrative economics

Assume, only for illustration:

- profitable principal: `100,000 CKB` after occupied capacity;
- observed simple-annualized AR change remains `2.05%`;
- twelve harvests per year; and
- no rate change, missed cycle, downtime, fee, or rounding effect.

Gross annual compensation would be about `2,050 CKB`, or roughly `171 CKB` per 30-day period. This
is approximately `0.17%` of principal per cycle, not 2% monthly. The on-chain payout can preserve
the full gross compensation because executor rewards are pre-funded separately, but the user's
economic net benefit must still subtract those funded rewards, any allowed protocol fee, and the
compensation lost during the preparation-to-redeposit gap. Small deposits may be uneconomic to
harvest monthly.

The UI must calculate and show:

- current accrued compensation;
- estimated compensation at the selected preparation window;
- estimated gross and net payout;
- occupied capacity;
- fixed executor rewards;
- expected time out of the DAO;
- break-even principal for the selected cadence; and
- a warning when projected economic net benefit is below `min_payout`.

### 8.12 Cancellation and recovery

| State | Owner action | Expected result |
|---|---|---|
| Deposited, before phase one | Cancel future automation | Job closes; DAO deposit remains owner-recoverable |
| Phase one submitted but unconfirmed | Submit owner transaction if inputs remain live | Normal input contention; one transaction wins |
| Withdrawing, before maturity | Stop recurrence | Cannot undo phase one; wait until claim epoch |
| Claim-ready | Exit to owner instead of redeposit | Principal plus compensation goes to owner policy |
| Budget exhausted | Refill or exit | No executor has unpaid authority |
| Deprecated script version | Migrate through owner-signed path | No executor-controlled migration |

An emergency recovery transaction must never depend on the hosted API or the original Automata
operator. The SDK, raw schema, code hashes, and recovery CLI must be published and reproducible.

## 9. Candidate NervDAO Integration Specification

### 9.1 Integration scope

NervDAO remains the user-facing portfolio and wallet interface. Automata supplies:

- epoch and scheduling calculations;
- policy and setup transaction builders;
- Job Cell discovery and status;
- executor network/API integration;
- receipts and failure explanations; and
- recovery and cancellation transaction builders.

### 9.2 Proposed user journey

1. The user opens a DAO deposit detail view.
2. A compact `Automation` section shows `Off`, `Reminders`, or `Harvest compensation`.
3. The user selects a cadence and payout address.
4. NervDAO shows principal, current rate estimate, projected gross compensation, fixed costs,
   estimated net payout, and the smart-lock risk disclosure.
5. The user reviews exact policy constraints and signs the setup transaction.
6. The dashboard shows a timeline: `Deposited`, `Prepare window`, `Withdrawing`, `Claim date`, and
   `Next cycle`.
7. The user may pause future recurrence, add reward budget, change only policy-permitted fields, or
   begin an owner recovery flow.

### 9.3 UI requirements

- Never label the feature as "2% monthly."
- Keep APY explicitly annualized and derived from recent chain data.
- Use epoch-aware dates with an "estimated" qualifier for wall-clock time.
- Separate principal, accrued compensation, occupied capacity, rewards, and fees.
- Show the exact payout lock and owner recovery lock.
- Show the approved phase-one executor identities and explain that they are trusted for timing,
  though not for custody or payout selection.
- Display contract version and audit status.
- Require an additional risk acknowledgement for unaudited testnet versions.
- Never imply that a scheduled job is guaranteed until it confirms.
- Provide transaction hashes for setup, prepare, claim/redeposit, cancellation, and recovery.
- Disable mainnet setup for unsupported wallet locks or unreviewed script versions.

### 9.4 Current code integration points

Based on the 19 September 2026 NervDAO source snapshot:

| Existing area | Current responsibility | Proposed integration |
|---|---|---|
| `src/hooks/DaoCollect.tsx` | Discovers deposited and withdrawing DAO cells | Add vault/job discovery as separate typed records |
| `src/utils/epoch.ts` | Calculates claim epoch and profit | Replace duplicate formulas with tested CCC/Automata helpers |
| `DaoDepositDetailModal.tsx` | Builds phase one and asks signer to send | Add Cycle Guard and vault setup actions |
| `DaoWithdrawDetailModal.tsx` | Builds phase two and asks signer to send | Add automation status and owner recovery path |
| `DashboardProfile.tsx` | Estimates annualized APY from AR change | Reuse rate display, add net-harvest estimator |
| CCC signer integration | Prepares, signs, sends ordinary transactions | Used for setup/cancel/recovery, not executor authority |

The integration should be proposed upstream as an isolated feature with testnet-first feature flags.
Do not fork NervDAO permanently unless maintainers decline the integration.

### 9.5 API contract for NervDAO

```http
GET /v1/accounts/{lockHash}/jobs?kind=dao-harvest
GET /v1/jobs/{jobId}
GET /v1/jobs/{jobId}/events
GET /v1/jobs/{jobId}/quote
POST /v1/jobs/{jobId}/simulate-cancel
POST /v1/jobs/{jobId}/simulate-recovery
```

All mutation endpoints return an unsigned transaction for local wallet review. The API never asks
for a seed phrase, private key, or general-purpose signature.

## 10. Automation Families and CKB Application Evidence

Automata should support a workflow only when the action can be narrowly authorized and validated.
The taxonomy separates three concepts that must not be conflated:

- an **automation family** describes the operational lifecycle being shared;
- a **trigger** identifies the evidence that makes a job eligible; and
- an **action policy** constrains the exact application state transition and outputs.

The same trigger may serve several families, while every application still owns its business
rules. An executor observing an event does not make that event trustworthy; the transaction must
carry evidence that the relevant CKB scripts can verify.

### 10.1 Automation families

| Family | Typical trigger | Executor responsibility | Candidate CKB evidence | Release posture |
|---|---|---|---|---|
| Deadline finalization | Block, epoch, or timestamp lower bound plus live state | Finalize, release, refund, close, or enter a terminal state | CKB Kickstarter, CKBoost | **V1** |
| Recurring distribution | Repeating block or epoch interval | Pay bounded recipients and create exactly one successor | CCC Schedule Send, CKBoost rewards, grants and payroll | **V1** |
| Multi-stage maturity | Confirmation of one transaction plus later maturity | Continue a deposit, withdrawal, vesting, or claim workflow | NervDAO, iCKB | Pilot after policy review |
| State transition and batching | Matching instruction or state cells | Batch compatible intents, retry contention, and advance state | .bit / DAS | **V1**, narrow predicates only |
| Human-gated continuation | Approval, vote, or multisig result already committed in verifiable state | Execute an already-approved payout or settlement | PactAgent, CKBoost tips and rewards | V1 only when approval is objectively verifiable |
| Condition-triggered risk action | Valid oracle or referenced state crosses a threshold | Liquidate, repay, top up, or rebalance within strict caps | Stable++ | Later; oracle and value-at-risk review required |
| Maintenance and cleanup | Expired, superseded, or accumulated state | Cancel orders, reclaim capacity, settle batches, or compact state | iCKB limit orders and future marketplaces | Later; anti-spam economics required |
| Cross-layer operational settlement | Verifiable external/Fiber state plus CKB conditions | Close, recover, sweep, or reconcile | LiquidLane | Later; credentials and custody boundary unresolved |

V1 should prove deadline finalization and recurring distribution using the same Job Cell lifecycle.
A narrow state-transition adapter is a useful third proof if a partner's existing scripts already
authorize permissionless construction. Oracle-driven and Fiber workflows materially expand the
trust model and are not V1 shortcuts.

### 10.2 Evidence from named CKB applications

| Application or project | Verified need | Maturity represented by the cited source | Automata opportunity and boundary |
|---|---|---|---|
| [.bit / DAS](https://talk.nervos.org/t/das-ckb-keeper/5700) | Published keeper design consumes instruction cells, batches registrations, retries after cell contention, and rewards the successful keeper | Historical 2021 architecture description; current adoption was not re-verified | Strong direct precedent for permissionless state-transition jobs; not a current partner commitment |
| [CKB Kickstarter](https://talk.nervos.org/t/introducing-ckb-kickstarter-decentralized-all-or-nothing-crowdfunding-on-nervos-ckb-testnet-mvp-live/10130) | Ten-second polling bot finalizes expired campaigns, releases successful pledges, and refunds failed pledges through permissionless paths | Reported live and end-to-end verified on testnet on 27 April 2026; external review and mainnet deployment were still future work | Best concrete deadline reference; Automata could replace its application-specific polling, fee wallet, retry, and receipt layer without replacing campaign rules |
| [PactAgent](https://talk.nervos.org/t/pactagent-from-application-to-infrastructure/10352) | Separate workers implement deadlines, settlement, retries, stale-lock recovery, dead letters, and audited replay | Active application/infrastructure development; no testnet or mainnet claim is inferred here | Reusable worker evidence; human proof review and disputes remain PactAgent decisions, and its CKB lock must authorize any autonomous settlement |
| [CCC Schedule Send](https://github.com/ckb-devrel/ccc-schedule-send) | Dedicated backend schedules token sends by chain height and maintains status/retry behavior | CKB DevRel reference backend; public production usage was not established | Direct recurring-distribution reference; Automata should replace broad server signing with a constrained funded policy rather than copy its custody model |
| [iCKB / NervDAO](https://ickb.org/) | Pooled DAO deposits, receipt conversion, staggered maturities, two-phase withdrawals, and limit orders create maturity and cleanup work | iCKB dApp exposes mainnet and testnet connections and cites audited L1 scripts; its web dApp is explicitly unaudited | Candidate multi-stage and maintenance adapters; do not duplicate its existing liquidity function or assume its cells are Automata-compatible |
| [CKBoost](https://talk.nervos.org/t/dis-ckboost-gamified-community-engagement-platform-proposal/8832) | Time-bounded campaigns, funded CKB/xUDT pools, approved submissions, tipping approvals, and reward distribution | Testnet application reported live by the Community Catalyst; production security was not independently verified here | Automate campaign close and already-approved payouts; never automate subjective proof approval |
| [Stable++](https://stablepp.gitbook.io/stable++/) | Overcollateralized vaults and liquidation rules require timely action when collateral conditions are met | Nervos Foundation reported an October 2024 mainnet launch; public docs still contain pre-launch caveats, so current parameters need direct confirmation | Strategically valuable condition-triggered adapter; oracle proof, permissionless entry points, slippage, and current contracts must be verified first |
| [LiquidLane](https://talk.nervos.org/t/liquidlane-lp-backed-fiber-channel-liquidity/10686) | Lease expiry requires routing shutdown, pending-payment settlement, channel rebalance/close, recovery-lock settlement, and vault reconciliation | Testnet prototype; September 2026 Spark proposal was rejected over unresolved custody and recovery safeguards | Evidence of cross-layer operational burden, not a ready integration; Automata cannot solve Fiber credentials or unsafe custody design |

These entries establish repeated demand signals. None counts toward the required three design
partners until its maintainers provide written integration intent and the technical precondition in
Section 3.5 is demonstrated.

### 10.3 Prioritization matrix

| Priority | Use case | Trigger | Action | V1 fit | Main risk |
|---:|---|---|---|---:|---|
| 1 | Crowdfunding/campaign finalization | Deadline + campaign state | Finalize, release, refund, or close | Yes | Application policy integration |
| 2 | Recurring grant/payroll/reward | Epoch or block interval | Bounded recipient payments plus successor | Yes | Long-lived budget and recipient binding |
| 3 | Instruction-cell batching | Matching live instructions | Batch deterministic state transitions | Yes, narrow | Contention and application-specific invariants |
| 4 | Escrow timeout/refund | Deadline + unresolved state | Return funds or enter a committed timeout path | Yes | Correct recipient and dispute boundaries |
| 5 | Auction finalization | Close epoch + highest-bid state | Settle asset and seller payment | Yes | Contention and anti-sniping rules |
| 6 | Vesting tranche release | Epoch milestone | Release capped tranche | Yes | Beneficiary migration |
| 7 | DAO Cycle Guard | Epoch window | Notify or broadcast a prepared phase-one transaction | Candidate | Wallet support, stale inputs, and fees |
| 8 | DAO Harvest Compensation | DAO cycle boundary and confirmed headers | Prepare, claim, payout, and redeposit | Pilot only | Vault risk and phase-one timing trust |
| 9 | Order expiry cleanup | Expiry + live order | Cancel, refund, and compact state | Later | Spam economics |
| 10 | Protocol batch settlement | State threshold or interval | Deterministic batch transition | Later | Transaction size and application coupling |
| 11 | Collateral maintenance | Verifiable price/state proof | Repay, top up, or liquidate within limits | Later | Oracle, contention, slippage, and value at risk |
| 12 | Fiber/cross-layer settlement | Verifiable external state | Close, recover, sweep, or reconcile | Later | Credentials, custody, and protocol boundary |
| 13 | HTTP/API automation | Signed attestation | Policy-limited action | Later | Explicit trusted attestor |

### 10.4 Crowdfunding finalization

A campaign publishes a deadline job when created. After the deadline, an executor builds either a
creator-release or refund-state transaction. The campaign scripts decide whether the target was
met; Automata validates timing, reward, job consumption, and optional receipt creation.

Good fit because the action is public, deterministic, and already requires no owner discretion
after the campaign rules are committed.

### 10.5 Escrow expiry and refund

An escrow policy may allow settlement by mutual signatures before a deadline, or refund to the
buyer after an unresolved timeout. An Automata job handles only the timeout path. It cannot choose
who is right in a dispute.

Good fit when the timeout outcome and recipient are fully committed in the escrow cell.

### 10.6 Recurring grants, payroll, and allowances

A treasury funds a finite recurring job with fixed recipients, per-period caps, reward budget, and
end epoch. Every execution creates one successor with lower remaining budget and incremented
sequence.

Good fit for predictable schedules. V1 should avoid mutable recipient lists unless changes require
the treasury's ordinary signature.

### 10.7 Auction finalization

After an auction close epoch, any executor settles the currently committed highest bid, transfers
the asset, pays the seller, refunds any policy-defined balances, and receives a fixed reward.

Good fit if the auction contract itself makes the winning state unambiguous. Anti-sniping time
extensions must update or supersede the job deterministically.

### 10.8 Vesting and streaming release

A grant or team allocation can be represented as finite tranches. At each epoch milestone, the job
releases no more than the committed amount and creates a successor for the next tranche.

Good fit because it avoids giving the executor discretion over recipient or amount. Continuous
per-second streaming is not a good L1 scheduling target; coarse tranches are more economical.

### 10.9 Order expiry and state cleanup

DEX, launchpad, or marketplace orders often leave expired cells that users must reclaim manually.
A job can expire the order, refund the committed owner, and optionally pay an executor from an
explicit cleanup bounty.

Good fit when cleanup value exceeds fees and when malicious users cannot create unprofitable jobs
that executors are required to process.

### 10.10 Collateral protection

A user could pre-authorize a capped top-up, repayment, or liquidation action when a cryptographic
price proof crosses a threshold. This is strategically valuable but excluded from V1 because
oracle trust, fast contention, slippage, and high value at risk materially expand the threat model.

## 11. System Architecture

```text
                             +----------------------+
                             | CKB application      |
                             | CCC wallet + UI      |
                             +----------+-----------+
                                        |
                          create/cancel | inspect
                                        v
+----------------+            +---------+----------+
| CKB node       |<---------->| Automata SDK       |
| + indexer      |            | + adapter kit      |
+-------+--------+            +---------+----------+
        ^                               |
        | read/simulate/broadcast       | deterministic builder
        |                               v
+-------+----------------+    +---------+----------+
| Permissionless         |--->| Policy adapter     |
| executor(s)            |    | DAO/campaign/etc. |
+-------+----------------+    +--------------------+
        |
        | valid transaction
        v
+-------+--------------------------------------------------+
| CKB                                                     |
| Job Cell scripts + policy scripts + application scripts |
| Atomic action + reward + optional successor             |
+----------------------------------------------------------+
        |
        v
+------------------------+
| Read API / console     |
| events, receipts, SLOs |
+------------------------+
```

### 11.1 Trust boundaries

| Component | Trusted for | Not trusted for |
|---|---|---|
| CKB consensus and scripts | Validity and atomic settlement | Timely initiation |
| Application policy | Permitted state transition | Executor availability |
| Executor | Building and submitting useful transactions | Custody or policy decisions |
| Index/API | Convenient discovery and notifications | Source-of-truth state |
| Application UI | Accurate transaction explanation | Bypassing on-chain checks |
| User wallet | Setup, cancellation, recovery authorization | Background availability |

For DAO harvesting, the approved phase-one executor set is additionally trusted for timing only.
It is not trusted with custody or output selection.

## 12. Core Protocol

### 12.1 Logical Job schema

```text
table JobDataV1 {
  version: Uint16,
  flags: Uint16,
  job_id: Byte32,
  sequence: Uint64,
  state: Byte,
  trigger_kind: Uint16,
  trigger_params_hash: Byte32,
  policy_script_hash: Byte32,
  payload_hash: Byte32,
  reward: Uint64,
  remaining_budget: Uint64,
  not_before: Uint64,
  not_after: Uint64, // scheduling metadata unless policy proves freshness
  remaining_runs: Uint32,
  cancel_lock_hash: Byte32,
}
```

This is a logical draft, not a final Molecule definition. Capacity measurements and script-cycle
benchmarks may justify packing or splitting fields. One Job Cell consumption pays one reward. A
multi-stage workflow creates a policy-constrained successor carrying the next stage's trigger,
state commitment, and reward; the generic schema does not encode DAO-specific stage names.

### 12.2 Job identity

`job_id` should be derived with domain separation from the creation transaction commitment, output
index or Type ID, creator nonce, and policy hash. The final method must prevent accidental identity
reuse across networks and protocol versions.

### 12.3 Job lifecycle invariants

1. A one-shot job produces no successor.
2. A recurring execution produces exactly one successor.
3. The successor keeps the same identity and increments sequence by exactly one.
4. Immutable policy and payload commitments cannot change.
5. Remaining budget cannot increase without a separately authorized top-up path.
6. Rewards do not exceed the committed amount.
7. A cancellation cannot earn an execution reward.
8. A job with policy-verifiable expiry cannot execute after that expiry. Otherwise `not_after` is
   advisory scheduler metadata and must not be presented as an on-chain rejection rule.
9. All unspent job value is preserved in required successor or refund outputs.
10. Executor identity is bound to the reward output.

### 12.4 Trigger modules

| Trigger | Evidence available to scripts | V1 |
|---|---|---:|
| Absolute block/epoch/timestamp `since` | Input `since` and consensus | Yes |
| Matching live input/state transition | Transaction inputs/outputs | Yes, narrow |
| Referenced cell/header predicate | Cell/header deps | Yes, narrow |
| Signed oracle statement | Witness signature and policy | No |
| Webhook/API result | Attestor signature only | No |
| Indexer query result | None by itself | Never as proof |
| Upper-bound time expiry | No native current-tip proof from `since` | No, unless policy adds freshness proof |

### 12.5 Action policy interface

Each policy specification defines:

- required application inputs and dependencies;
- allowed outputs and exact or capped values;
- payload encoding and hash rules;
- trigger evidence;
- successor rules;
- cancellation and recovery behavior;
- executor reward location and identity binding;
- cycle limits; and
- error codes and test vectors.

### 12.6 Executor reward protection

The transaction must bind the reward lock to an executor commitment. A mempool observer may copy
and rebroadcast the same transaction, but cannot replace the reward recipient without invalidating
the commitment. Competing executors may construct different valid transactions; normal CKB input
contention ensures only one can consume the live job.

### 12.7 Fees

V1 uses a fixed posted reward. The executor supplies fee inputs, pays the network fee, and receives
the reward atomically. Fee auctions, staking, slashing, and dynamic on-chain bidding are excluded.

If no executor accepts the posted reward, the job remains live. The owner may top up through an
explicit signed transaction if the policy supports it.

## 13. Executor Design

### 13.1 Responsibilities

- Discover supported live Job Cells.
- Verify schema and policy versions before doing expensive work.
- Derive eligibility from chain state.
- Build through a deterministic adapter.
- Resolve inputs and required headers.
- Run local checks and node `dry_run_transaction`.
- Verify expected reward and fee margin.
- Broadcast through one or more configured nodes.
- Track proposal, commit, confirmation depth, rejection, conflict, and reorg.
- Retry idempotently.
- Publish a signed operational receipt without treating it as chain authority.

### 13.2 Executor state model

```text
DISCOVERED
  -> UNSUPPORTED
  -> NOT_YET_ELIGIBLE
  -> READY
  -> BUILDING
  -> SIMULATED
  -> SUBMITTED
  -> PROPOSED
  -> COMMITTED
  -> CONFIRMED

Retry branches:
  BUILDING/SIMULATED -> INVALID | RETRYABLE
  SUBMITTED/PROPOSED -> DROPPED | CONFLICTED | RETRYABLE
  COMMITTED          -> REORGED -> READY

Terminal:
  CONFIRMED | CANCELLED | EXPIRED | CONSUMED_BY_OTHER | INVALID | UNSUPPORTED
```

### 13.3 Failure codes

At minimum:

```text
NOT_YET_ELIGIBLE
PREPARE_WINDOW_MISSED
ALREADY_CONSUMED
INPUT_CONFLICT
INSUFFICIENT_JOB_BUDGET
REWARD_BELOW_OPERATOR_MINIMUM
POLICY_VERSION_UNSUPPORTED
PAYLOAD_HASH_MISMATCH
INVALID_APPLICATION_STATE
MISSING_HEADER
IMMATURE_SINCE
SIMULATION_REJECTED
NODE_REJECTED
FEE_INPUT_UNAVAILABLE
TX_DROPPED
TX_REORGED
JOB_EXPIRED
JOB_CANCELLED
RECOVERY_REQUIRED
```

### 13.4 Concurrency

Permissionless policies do not require leader election. Each executor independently evaluates
profitability and may submit; input contention selects a winner. Operators should add randomized
delay where immediate execution is unnecessary. Restricted policies, including V1 DAO phase one,
first authenticate the executor against the committed set and then use the same contention model
among approved operators.

### 13.5 Adapter interface

```ts
interface AutomataAdapter<TContext = unknown> {
  readonly policyHash: Hex;
  readonly version: number;

  inspect(job: Cell, client: Client): Promise<JobInspection<TContext>>;
  eligibility(
    inspection: JobInspection<TContext>,
    tip: ClientBlockHeader,
  ): Promise<Eligibility>;
  build(
    inspection: JobInspection<TContext>,
    executor: ExecutorIdentity,
  ): Promise<Transaction>;
  verifyBuilt(
    transaction: Transaction,
    inspection: JobInspection<TContext>,
  ): Promise<VerificationResult>;
}
```

The adapter must be deterministic for the same chain snapshot and executor identity, except for
explicitly documented fee inputs and change.

## 14. SDK and API

### 14.1 TypeScript SDK modules

```text
@ckb-automata/core        schema, IDs, states, receipts
@ckb-automata/ccc         CCC transaction and script helpers
@ckb-automata/dao         DAO cycle guard and harvest adapter
@ckb-automata/policies    reference policy metadata
@ckb-automata/testing     fixtures, mock chain, adversarial helpers
```

### 14.2 SDK operations

```ts
quoteJob(params): Promise<JobQuote>
buildCreateJob(params): Promise<Transaction>
buildTopUpJob(job, amount): Promise<Transaction>
buildCancelJob(job): Promise<Transaction>
buildRecovery(job, mode): Promise<Transaction>
inspectJob(cell): Job
deriveJobState(job, chainState): Promise<DerivedJobState>
calculateDaoPrepareWindow(depositHeader, tip, policy): PrepareWindow
calculateDaoClaimEpoch(depositHeader, withdrawHeader): Epoch
quoteDaoHarvest(deposit, tip, policy): Promise<HarvestQuote>
```

### 14.3 Read API response principles

- Every job response includes the outpoint and block reference used to derive it.
- Derived wall-clock dates include uncertainty and the exact epoch representation.
- Monetary values are integer shannons in JSON; formatted CKB is presentation-only.
- API state is labeled as `indexed`, `submitted`, `committed`, or `confirmed`.
- Reorged events remain in history and point to their replacement state when known.
- Pagination is stable and cursor-based.

### 14.4 Webhooks

Optional webhooks may report:

```text
job.prepare_window_opened
job.transaction_submitted
job.transaction_confirmed
job.prepare_window_missed
job.budget_low
job.expired
job.cancelled
job.recovery_required
```

Webhooks are notifications, not trigger proofs. Delivery uses signed payloads, retries with
backoff, idempotency keys, and an event replay endpoint.

## 15. Observability and Operations

### 15.1 Public job view

Display:

- job ID, sequence, policy, and version;
- live outpoint and chain status;
- trigger and next eligibility;
- action summary decoded by the adapter;
- reward and remaining budget;
- executor and transaction hashes;
- confirmation depth;
- failure code and retry time; and
- successor or terminal state.

### 15.2 Metrics

```text
automata_jobs_discovered_total
automata_jobs_ready
automata_build_seconds
automata_simulation_failures_total{code}
automata_submissions_total{policy}
automata_confirmations_total{policy}
automata_execution_latency_seconds{policy}
automata_reorgs_total
automata_input_conflicts_total
automata_prepare_windows_missed_total
automata_rewards_earned_shannons_total
automata_rpc_errors_total{provider}
automata_index_lag_blocks
```

### 15.3 Service objectives for a hosted executor

- Index lag: less than two blocks for 99% of observed time.
- Eligible-job detection: within two blocks for 99% of jobs.
- Valid transaction simulation: attempted within the policy window SLO.
- Confirmation tracking: no unclassified submitted transaction older than the configured timeout.
- Notifications: 99% delivered or terminally classified within five minutes.

These are service targets, not protocol guarantees.

### 15.4 Operator requirements

- Two independent RPC endpoints or self-hosted nodes.
- Persistent database for attempts and reorg history.
- No user private keys.
- Executor fee keys isolated from service credentials.
- Rate limits and local simulation before broadcast.
- Alerting on index lag, missed windows, reward drain, and repeated policy failures.
- Reproducible container images and pinned script metadata.
- Documented backup and restore for operational state; chain state remains recoverable independently.

## 16. Security Model

### 16.1 Core security invariants

- Principal cannot leave its permitted owner/vault/redeposit path.
- An executor cannot change payout recipient.
- An executor cannot increase reward or protocol fee.
- A job cannot execute twice.
- Recurrence cannot fork into multiple successors.
- Sequence cannot skip, repeat, or move backward.
- Immutable intent cannot be replaced during execution.
- Cancellation and execution are distinguishable and mutually exclusive after confirmation.
- Script upgrades cannot silently alter a live job's policy.

### 16.2 Threat matrix

| Threat | Control | Residual risk |
|---|---|---|
| Executor steals principal | Exact output and value-conservation checks | Policy implementation bug |
| Executor redirects compensation | Immutable payout lock/hash | Owner chose wrong address |
| Mempool reward theft | Bind reward to executor commitment | Competition and propagation remain |
| Duplicate execution | Unique consumed cells and sequence | Wasted competing fees |
| Early phase one | Required not-before `since` and lock checks | Bad lower-bound configuration |
| Late phase one | User-approved executor set; operators stop at deadline | Approved operator can grief timing |
| Missed DAO boundary | Safety margin, multi-executor redundancy | Congestion/reorg can still miss |
| Phase two too early | DAO script and absolute epoch `since` | Longer-than-estimated wait |
| Principal reduced by fee | Exact principal output | Rounding/occupied-capacity mistakes |
| Malicious successor | Exact identity, sequence, policy, budget checks | Migration design complexity |
| Cancellation race | Normal input contention and clear UI | User transaction may lose race |
| Reorg after apparent success | Configurable confirmation depth and retry | Deep PoW reorg |
| Indexer lies or lags | Verify against node and scripts | Multiple node failure |
| DoS jobs | Operator allowlist of policy versions and local simulation | Discovery spam |
| Underfunded jobs | Profitability filter and low-budget warning | No liveness guarantee |
| Compromised executor fee key | Holds only operator funds; capped rewards | Operator loss/service outage |
| Compromised API | Read results verified; unsigned tx reviewed locally | Phishing UI risk |
| Script dependency unavailable | Immutable dep references and migration path | Long-lived job stranding |

### 16.3 DAO-specific adversarial tests

- Phase-one output at the wrong index.
- Phase-one output with changed principal, lock size, lock args, type, or data.
- Phase one signed by an identity outside the approved executor set.
- Prepare just before and just after the exact fractional boundary.
- Approved executor broadcasts a previously built phase-one transaction after the deadline.
- Claim with the wrong deposit header.
- Claim with the wrong phase-one header.
- Claim with incorrect witness header index.
- Claim with an immature or differently encoded `since`.
- Compensation payout redirected or omitted.
- Principal redeposit reduced by one shannon.
- Reward exceeds cap by one shannon.
- Two successor jobs or no successor when one is required.
- Replay with old sequence.
- Owner cancellation racing prepare and claim.
- Reorg of phase one after a phase-two transaction was built.
- Fee input conflict without job input conflict.
- Insufficient output capacity after a script-size change.
- Unsupported network DAO script version.

### 16.4 Audit requirements

Before mainnet:

- independent audit of the Job script and every policy or vault included in the pilot;
- specification-to-code conformance review;
- property tests for value conservation and recurrence;
- fuzzing of Molecule and witness parsing;
- differential tests against the deployed DAO system script;
- transaction-cycle and maximum-size benchmarks;
- testnet competition and reorg exercises;
- public findings and remediation report; and
- reproducible deployed binary hashes.

## 17. Privacy and Data Handling

Jobs are public chain objects. The UI must make clear that payout addresses, cadence, job status,
and transaction history can be correlated.

The hosted service should store only:

- public chain identifiers;
- notification destinations explicitly supplied by the user;
- delivery and operational logs; and
- executor accounting data.

It must not store seed phrases, wallet private keys, unrestricted signed messages, or wallet
session tokens. Notification data should have a deletion policy and be separable from public job
records.

## 18. Testing Strategy

### 18.1 Contract tests

- Golden valid transactions for every policy transition.
- One mutation test per enforced field.
- Boundary tests for integers, occupied capacity, epoch fractions, and rewards.
- Property tests for conservation and exactly-one-successor rules.
- Fuzz tests for all witness and data parsers.
- Cycle-count regression tests for supported CKB-VM versions.

### 18.2 SDK tests

- Cross-check DAO calculations against CCC fixtures and RFC examples.
- Round-trip every Molecule structure.
- Golden transaction serialization and hashes.
- Network-specific script metadata tests.
- Wallet preparation tests for setup, cancel, and recovery.
- No floating-point arithmetic for capacity or epoch decisions.

### 18.3 Executor tests

- Two or more executors race the same job.
- Reward redirection attempt from a copied mempool transaction.
- RPC disagreement and lag.
- Dropped transaction and fee-input replacement.
- Input consumed by another transaction.
- Node restart during each state.
- Database restore and full chain reconciliation.
- Shallow reorg before and after configured confirmation.
- Missed preparation window behavior.

### 18.4 End-to-end environments

1. **Unit/mock:** fast script and SDK fixtures; no live claims.
2. **Local dev chain:** accelerated epoch fixtures and deterministic reorgs.
3. **Public testnet:** real RPC/indexer behavior and independent executors.
4. **Mainnet shadow mode:** discover and build without broadcast; compare predicted outcomes.
5. **Guarded mainnet pilot:** capped principal, allowlisted audited policy, public monitoring.

Results from these environments must never be combined into one success count.

## 19. Repository and Ownership Model

Recommended monorepo for the protocol implementation:

```text
ckb-automata/
  contracts/
    job-lock/
    optional-policy-vaults/
    policies/
      deadline/
      recurring-distribution/
      dao-harvest/             optional reference policy
  schemas/
    molecule/
    test-vectors/
  packages/
    core/
    ccc/
    dao/
    adapter-kit/
    testing/
  services/
    executor/
    index-api/
    notifier/
  apps/
    console/
  integrations/
    nervdao/                   optional candidate integration
    campaign-example/
  docs/
    protocol-specification.md
    dao-harvest-specification.md
    threat-model.md
    operator-runbook.md
    integration-guide.md
    recovery-guide.md
    deployments.md
  scripts/
    generate-schemas/
    verify-deployments/
```

Ownership boundaries:

- Contracts and schemas own consensus-critical behavior.
- SDK packages own encoding and transaction construction.
- Executors own liveness, not authorization.
- The index API owns a disposable read model.
- Integrations own product UX and application-specific adapters.
- Deployment metadata is reviewed like code and pins exact binaries/outpoints.

## 20. Deployment and Release

### 20.1 Environments

| Environment | Purpose | Broadcast policy |
|---|---|---|
| Local | Development and deterministic tests | Local only |
| Testnet | Public integration and competition | Enabled |
| Mainnet shadow | Observe and simulate real jobs | Disabled |
| Mainnet pilot | Capped audited jobs | Enabled for allowlisted policy version |
| Mainnet general | Permissionless supported policies | Enabled after evidence gate |

### 20.2 Deployment manifest

Each release publishes:

```text
network
genesis_hash
consensus_version
contract_name
semantic_version
code_hash
hash_type
cell_dep outpoint
binary_sha256
source_commit
schema_hash
audit_report_hash
activation_epoch
deprecation_epoch (optional)
```

### 20.3 Upgrade policy

- A live job keeps its original immutable code references.
- New versions do not mutate old job semantics.
- Owner-signed migration is the default.
- Permissionless migration is allowed only if the old job committed to that exact path.
- Critical vulnerabilities may disable hosted executor support, but cannot rewrite chain rules.
- Deprecation must leave enough time and tooling for owner recovery.

## 21. Business and Protocol Economics

### 21.1 Executor market

Each job posts fixed rewards. Executors choose jobs based on:

- reward;
- estimated transaction fee;
- build and simulation cost;
- expected contention;
- probability of inclusion;
- confirmation/reorg handling cost; and
- policy risk and support status.

The protocol does not promise execution merely because a job exists. Applications should fund a
reward that multiple operators find rational and may run their own fallback executor.

### 21.2 Sustainable services

Open protocol revenue opportunities include:

- hosted redundant execution with response targets;
- private executor deployment;
- integration engineering;
- policy and transaction review;
- monitoring, webhooks, and incident history; and
- managed notification service.

The open-source grant scope should fund the standard, contracts, SDK, executor, security work, and
reference integrations, not an indefinite subsidy for hosted execution.

### 21.3 DAO harvest break-even

Monthly harvesting is rational only when:

```text
expected gross compensation
  > prepare reward
  + roll reward
  + allowed protocol fee
  + value of compensation lost during withdrawal gap
  + user's minimum meaningful payout
```

The default UI should recommend a longer cadence or no harvesting when this inequality is false.

## 22. Delivery Roadmap

### M0: Demand and feasibility, 2 weeks

Deliverables:

- five structured interviews with teams operating or needing keepers;
- three written integration intents from independent teams;
- one deadline/finalization prototype with an external application's policy;
- one recurring-distribution successor prototype;
- one additional feasibility spike selected from maturity, batching, or human-approved continuation;
- exact occupied-capacity and CKB-VM cycle measurements for the selected policies;
- draft schemas and threat model; and
- two competing local executors.

The existing DAO Harvest Vault and Cycle Guard designs may satisfy the additional feasibility spike
only if NervDAO maintainers participate. Pass condition: two families execute without a general
user key, and at least three external teams provide written workflows they would integrate.

### M1: First external integration, 3 weeks

Deliverables:

- the lowest-risk committed partner integration, preferably deadline finalization;
- application adapter and policy fixtures;
- embedded status and recovery UI;
- stale-input, contention, and missed-trigger handling;
- notification service where the partner needs it; and
- partner-run user testing and integration review.

Pass condition: the partner runs the workflow from its own codebase with its own fallback executor.

### M2: Protocol and contract alpha, 5 weeks

Deliverables:

- Molecule schemas;
- Job Lock plus deadline and recurring-distribution policies;
- an optional application-specific vault lock only when the selected integration requires it;
- owner cancellation and recovery paths;
- golden vectors, property tests, and fuzz harnesses; and
- public testnet deployments.

Pass condition: published tests prove principal, payout, reward, recurrence, and recovery invariants.

### M3: SDK and executor, 4 weeks

Deliverables:

- TypeScript SDK and CCC package;
- Rust executor and the selected application adapters;
- dry-run, retry, conflict, and reorg handling;
- index API, webhooks, and console;
- operator and recovery runbooks; and
- reproducible deployment tooling.

Pass condition: independent executors process the same stream without duplicate state transitions
or reward redirection.

### M4: Integrations and sustained testnet, 6 weeks

Deliverables:

- three independent application integrations covering at least two automation families;
- at least one deadline/finalization integration;
- at least one recurring, batching, maturity, or approved-continuation integration;
- NervDAO Harvest Compensation only if demand, economics, and policy review pass;
- 30 consecutive days of public testnet history;
- fault-injection report; and
- economics report using measured fees and capacity.

Pass condition: three independent applications run real workflows from their own codebases.

### M5: Audit and guarded release, 5 weeks plus remediation

Deliverables:

- independent security audit;
- fixes and regression tests;
- mainnet shadow report;
- capped pilot policy and incident process;
- versioning and deprecation policy; and
- tagged, reproducible releases.

Pass condition: no unresolved critical or high-severity finding and all mainnet pilot limits are
enforced on-chain.

## 23. Acceptance Metrics

| Area | Acceptance threshold |
|---|---|
| External adoption | Three independent applications merge integrations |
| Workflow breadth | Two distinct action classes use the same job lifecycle |
| Sustained operation | 30 consecutive testnet days with public history |
| Adapter correctness | Every selected adapter matches its application reference rules and published fixtures |
| Contention safety | No duplicate transition across concurrent executor tests |
| Reward safety | No successful reward redirection in adversarial tests |
| Principal safety | No invariant test can reduce or redirect configured principal |
| Recovery | Every on-chain state has a documented owner recovery path |
| Resilience | Dropped, conflicted, and reorged attempts converge to valid state |
| Reproducibility | Third party builds identical binaries and runs an executor |
| Security | No unresolved critical/high audit finding before pilot |
| Transparency | Outpoints, tx hashes, policy versions, latency, and failures are queryable |

Synthetic executions, builder-owned examples, and external partner jobs must be reported
separately.

## 24. Adoption Plan

### 24.1 Start with the pain, not the marketplace

The first target is not executor count. It is replacing real manual or bespoke automation for
three applications.

1. Select the lowest-risk external application with a written integration intent.
2. Integrate one deadline application and one recurring distribution or state-transition application.
3. Validate any required constrained vault separately on testnet with capped values.
4. Have each application run its own fallback executor.
5. Add one independent executor and measure reward economics.
6. Publish failures and recovery evidence before promoting general use.

### 24.2 Integration promise

A normal integration should require:

- one existing or new policy script;
- one deterministic adapter;
- one job creation call;
- one status integration; and
- no custom executor fork.

If every application needs a different lifecycle or private executor branch, the shared protocol
has not generalized.

### 24.3 Funding path

Do not request a large production grant for the idea alone. Complete M0 and obtain external design
partners first. Any funding proposal should re-check the current CKB Community Fund process at the
time of submission; governance process proposals and operational platforms may have changed since
earlier published rules.

## 25. Existing Work and Collision Boundary

| Project | Existing capability | Automata boundary |
|---|---|---|
| [NervDAO](https://github.com/ckb-devrel/nervdao) | Wallet-connected DAO deposit, prepare, claim, APY display, iCKB UI | Embedded product surface; Automata adds durable policy and execution |
| [CCC](https://github.com/ckb-devrel/ccc) | Wallet abstraction, transaction construction, DAO helpers | Foundation SDK; not a job lifecycle or executor market |
| [ccc-schedule-send](https://github.com/ckb-devrel/ccc-schedule-send) | Backend scheduled sending with retry/status logic | Uses a server mnemonic and private-key signer; Automata avoids user-key custody |
| [iCKB](https://github.com/ickb/whitepaper) | Liquid token backed by a pool of DAO deposits | Alternative for liquidity; Harvest serves principal-preserving cash flow without issuing a token |
| [CKB Kickstarter](https://talk.nervos.org/t/introducing-ckb-kickstarter-decentralized-all-or-nothing-crowdfunding-on-nervos-ckb-testnet-mvp-live/10130) | Testnet bot executes permissionless finalization, release, and refund paths | Most concrete deadline reference; Automata adds a funded shared lifecycle rather than replacing campaign scripts |
| [PactAgent](https://talk.nervos.org/t/pactagent-from-application-to-infrastructure/10352) | Durable agreement workers, human review, settlement, retries, and replay | Automata may replace eligible on-chain execution jobs, not proof review, disputes, or tenant orchestration |
| [CKBoost](https://talk.nervos.org/t/dis-ckboost-gamified-community-engagement-platform-proposal/8832) | Campaign, quest, approval, reward-pool, and tipping workflows | Automata can continue already-approved actions; it must not decide whether proof is valid |
| [Stable++](https://stablepp.gitbook.io/stable++/) | Overcollateralized vaults and liquidation rules | Later oracle-driven candidate; compatibility and current parameters require direct verification |
| [LiquidLane](https://talk.nervos.org/t/liquidlane-lp-backed-fiber-channel-liquidity/10686) | Testnet prototype for Fiber lease funding and recovery | Cross-layer research evidence only; unresolved custody/recovery concerns are outside Automata's core |
| [Open Transaction Pool](https://github.com/EthanYuan/open-transaction-pool) | Partial transaction composition and streaming | Potential transport/composition layer, not funded conditional jobs |
| [CoBuild](https://talk.nervos.org/t/ckb-transaction-cobuild-protocol-overview/7702) | Composable transaction actions and human-readable intent | Message/action format may improve approval UX; does not provide liveness |
| [CellKit Actions](https://talk.nervos.org/t/spark-program-cellkit-actions-reusable-transaction-actions-for-ckb-apps/10375) | Reusable transaction actions | Actions can become adapters; Automata adds triggers, incentives, retries, receipts |
| [.bit / DAS Keeper pattern](https://talk.nervos.org/t/das-ckb-keeper/5700) | Permissionless instruction-cell processing, batching, retries, and incentives | Strong historical precedent; Automata standardizes the lifecycle across applications |

The novelty claim must stay narrow: Automata combines a funded conditional Job Cell, constrained
policy authorization, permissionless execution rewards, recurring state, recovery, and operational
receipts. It should reuse existing SDK, action, indexing, and transaction-composition work.

## 26. Risks, Kill Conditions, and Open Questions

### 26.1 Principal risks

- A vault script bug has direct value-at-risk.
- The economic value of monthly DAO harvesting may be too small for many deposits.
- Missing the preparation window can delay access by another cycle.
- Custom-lock occupied capacity reduces profitable capacity.
- Wallets may not clearly render policy setup and recovery transactions.
- Long-lived job dependencies and script deprecation are hard.
- Executors may centralize around one hosted operator if rewards are low.
- Application integrations may still require too much custom policy work.

### 26.2 Kill or narrow conditions

Stop or narrow the protocol if:

- users only want reminders and will not place funds under an audited constrained lock;
- the selected application maintainers do not see sufficient demand for their proposed automation;
- measured monthly harvest costs consume a material share of compensation;
- owner recovery cannot be made simple and independently executable;
- target wallet approval UX cannot explain the delegated authority;
- external teams prefer their existing keepers and will not integrate;
- each use case needs materially different lifecycle semantics;
- a maintained project already provides the same job lifecycle; or
- only builder-owned projects adopt the protocol.

If DAO harvesting is uneconomic but another family validates the shared lifecycle, remove Harvest
Compensation from the roadmap without narrowing Automata to reminders. If only one application
adopts the lifecycle, ship its local worker improvements without claiming a shared protocol.

### 26.3 Open protocol questions

1. Which two committed partner workflows should define the V1 policy interface?
2. Should every transition consume one Job Cell, or may a job encode a bounded stage list?
3. How are supported policy versions discovered without turning the API into an authority?
4. How should job top-ups preserve immutable intent and cancellation rights?
5. Which recovery transitions can remain consistent across application-specific policies?
6. Which CCC wallets can render policy authority, rewards, and recovery in human-readable form?
7. What reward and contention model attracts redundancy without unnecessary fee races?
8. Which CKB consensus and system-script versions must each deployment manifest support?
9. If NervDAO proceeds, should the Harvest Vault be standalone or use an Omnilock-compatible path?
10. If NervDAO proceeds, what preparation buffer best balances inclusion and lost compensation?
11. Can a freshness proof or bonded design safely remove the DAO phase-one executor set?
12. What oracle proof format could support risk actions without creating a general oracle network?
13. Which Fiber operations can be proven on CKB without exposing node credentials or expanding
    Automata into channel custody?

## 27. Recommended Build Decision

Proceed in two gates.

**Gate A: prove two families with external applications.** Build one monotonic deadline workflow
and one recurring or state-transition workflow. Require application-owned fallback execution and
show that both use the same job lifecycle without a general user key.

**Gate B: build the full protocol only after evidence.** Require a successful constrained-vault
prototype only when an integration needs one, an owner recovery demonstration for every funded
policy, and three independent integration commitments. A NervDAO integration additionally requires
measured positive harvest economics and maintainer interest.

The strongest project pitch is:

> CKB already verifies future-valid actions, but applications still need someone to notice,
> construct, submit, and recover the transaction. Automata makes that liveness work a funded,
> policy-constrained execution protocol. Deadline applications, recurring distributions,
> maturity-driven protocols, and deterministic maintenance jobs can share discovery, incentives,
> retries, receipts, and recovery while keeping business rules in their own scripts and never
> giving an executor a general key.

## 28. Primary Sources and Research Notes

### Normative CKB sources

- [RFC 2: Nervos CKB and the cell model](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0002-ckb/0002-ckb.md)
- [RFC 17: Transaction `since` precondition](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0017-tx-valid-since/0017-tx-valid-since.md)
- [RFC 22: Transaction structure](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0022-transaction-structure/0022-transaction-structure.md)
- [RFC 23: Deposit and Withdraw in Nervos DAO](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md)
- [RFC 42: Omnilock](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0042-omnilock/0042-omnilock.md)
- [Official DAO system script](https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/dao.c)
- [CKB releases and consensus compatibility](https://github.com/nervosnetwork/ckb/releases)

### Current product and SDK sources

- [NervDAO source](https://github.com/ckb-devrel/nervdao), inspected at
  `f3eec6581cf26838725f84bd42256a5ea8957cb4`
  - [Current phase-one builder and wallet send](https://github.com/ckb-devrel/nervdao/blob/f3eec6581cf26838725f84bd42256a5ea8957cb4/src/app/components/DaoDepositDetailModal.tsx)
  - [Current phase-two builder and wallet send](https://github.com/ckb-devrel/nervdao/blob/f3eec6581cf26838725f84bd42256a5ea8957cb4/src/app/components/DaoWithdrawDetailModal.tsx)
  - [Current AR-based APY estimate](https://github.com/ckb-devrel/nervdao/blob/f3eec6581cf26838725f84bd42256a5ea8957cb4/src/app/components/DashboardProfile.tsx)
- [CCC source](https://github.com/ckb-devrel/ccc), inspected at
  `ab98c7a772226cef78e865f6b37e83e7e2f57d66`
  - [DAO profit and claim-epoch helpers](https://github.com/ckb-devrel/ccc/blob/ab98c7a772226cef78e865f6b37e83e7e2f57d66/packages/core/src/ckb/transaction.ts)
- [iCKB whitepaper](https://github.com/ickb/whitepaper)
- [iCKB dApp and deployment/audit disclosures](https://ickb.org/)
- [CCC Schedule Send](https://github.com/ckb-devrel/ccc-schedule-send), inspected at
  `2129142e13a729e6dd1a7cc5fc37057b88d2aa10`
  - [Server mnemonic and private-key signing path](https://github.com/ckb-devrel/ccc-schedule-send/blob/2129142e13a729e6dd1a7cc5fc37057b88d2aa10/libs/check/src/check.service.ts)

### Adjacent ecosystem sources

- [CKB Kickstarter testnet application and automatic finalization bot](https://talk.nervos.org/t/introducing-ckb-kickstarter-decentralized-all-or-nothing-crowdfunding-on-nervos-ckb-testnet-mvp-live/10130)
- [PactAgent application and worker architecture](https://talk.nervos.org/t/pactagent-from-application-to-infrastructure/10352)
- [CKBoost proposal, implementation updates, and testnet workflows](https://talk.nervos.org/t/dis-ckboost-gamified-community-engagement-platform-proposal/8832)
- [CKBoost testnet status in the Community Catalyst report](https://talk.nervos.org/t/nervos-community-catalyst-quarterly-reports/8822/3)
- [Stable++ protocol documentation](https://stablepp.gitbook.io/stable++/)
- [Nervos Foundation 2024 report, including Stable++ launch status](https://www.nervos.org/assets/pdfs/2024_Nervos_Foundation_Year-end_Report.pdf)
- [LiquidLane testnet prototype and rejected Spark review](https://talk.nervos.org/t/liquidlane-lp-backed-fiber-channel-liquidity/10686)
- [Open Transaction Pool](https://github.com/EthanYuan/open-transaction-pool)
- [CKB Transaction CoBuild overview](https://talk.nervos.org/t/ckb-transaction-cobuild-protocol-overview/7702)
- [CellKit Actions](https://talk.nervos.org/t/spark-program-cellkit-actions-reusable-transaction-actions-for-ckb-apps/10375)
- [DAS Keeper design pattern](https://talk.nervos.org/t/das-ckb-keeper/5700)
- [CKB Community Fund DAO rules and process](https://talk.nervos.org/t/ckb-community-fund-dao-rules-and-process/6874)

### Live-rate methodology

The 2.05% simple-annualized snapshot in this document was calculated from the `AR` values in the `dao`
fields of mainnet block `20,521,318` (hash `0x42791f1c86c0b76b39ef7f22cb05c63ab37066484dfe9d5c9d326fd092faea19`,
`AR = 12042298733733015`) and block `20,445,718` (hash
`0xe0c347724996b0c7c8f49164f5a0309875ade52bbc2f005e7f63ff78a98ecc92`,
`AR = 12037052921326619`). Their timestamps span 13 September to 21 September 2026. The ratio
change was simple-annualized over a 365-day year by elapsed milliseconds, producing `2.049734%`.
The compounded annualized result for the same interval is approximately `2.071862%`; neither is a
guaranteed APY. The public endpoint was `https://mainnet.ckb.dev`. The simple estimate mirrors the
current NervDAO frontend approach and is included only to correct the "2% monthly" interpretation.
Product quotes must always refresh chain data, identify their annualization method, and label
estimates clearly.
