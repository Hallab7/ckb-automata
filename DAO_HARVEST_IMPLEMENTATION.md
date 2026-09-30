# CKAutomata DAO Harvest Compensation Implementation Plan

> A testnet-first CKAutomata feature that periodically makes accrued Nervos DAO compensation liquid
> while atomically returning the user's original amount to a new DAO deposit.

**Document type:** Focused implementation plan

**Planning snapshot:** 30 September 2026

**Target:** CKAutomata public testnet pilot; not a mainnet or audited release

**Canonical project specification:**
[CKB_AUTOMATA_FULL_PROJECT_DOCUMENTATION.md](./CKB_AUTOMATA_FULL_PROJECT_DOCUMENTATION.md)

**Existing platform plan:** [implementation.md](./implementation.md)

---

## 1. Implementation Outcome

This plan adds a `Harvest compensation` automation to CKAutomata. After one wallet-approved setup
transaction, CKAutomata coordinates two constrained DAO transitions for each selected cycle:

1. Shortly before the deposit's next eligible 180-epoch boundary, an approved executor prepares
   the DAO withdrawal. The original amount remains intact and the compensation is fixed by the
   block that confirms this transaction.
2. After the withdrawing cell matures, an executor claims it. That transaction atomically creates
   a new DAO deposit containing exactly the original amount and sends the accrued compensation to
   the user's chosen payout address.

The user pre-approves a narrow on-chain policy, not two unfinished raw transactions. The second raw
transaction cannot be built during setup because it needs the confirmed phase-one block header,
the resulting withdrawing cell, and its exact claim epoch.

The feature provides periodic liquidity. It must never claim to improve the Nervos DAO compensation
rate or create a fixed return; Nervos DAO compensation already compounds while the deposit remains
in the DAO.

## 2. Release Boundary

### 2.1 Included in the first pilot

- CKB testnet only.
- New DAO deposits created under the Harvest Vault Lock.
- One principal amount and one compensation payout address per automation.
- One harvest or a finite number of recurring harvests.
- Exact rational-epoch scheduling derived from confirmed CKB headers.
- A separately funded, capped reward for each executor transition.
- Wallet-approved setup, stop-recurrence, exit, and recovery transactions.
- Phase-one preparation, phase-two claim/redeposit, indexing, notifications, and receipts.
- Responsive setup, review, list, detail, activity, cancellation, and recovery interfaces.

### 2.2 Excluded from the first pilot

- Mainnet deployment or production-readiness claims.
- Migration of an existing standard-lock DAO deposit into the vault.
- Infinite recurrence.
- Mutable principal, payout address, or executor rewards without owner authorization.
- Custody of wallet keys, seed phrases, or unrestricted signatures.
- Arbitrary scheduled wallet transactions.
- Guaranteed execution time, compensation rate, or payout amount.
- Deducting executor rewards or network fees from the protected principal.

Supporting existing DAO deposits requires a separate owner-signed migration specification because
their current phase, header dependencies, and lock script cannot be changed as ordinary CKB.

## 3. Fixed Protocol Decisions

| Area             | Decision                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization    | A purpose-built Harvest Vault Lock binds the Job ID, owner, Job Lock, and policy, then authorizes only specified transitions             |
| Owner control    | The owner path requires a co-spent input whose full lock hash matches the committed owner lock                                           |
| Principal        | Every automated transition preserves the exact `principal_capacity`; only the owner exit path may return it to the owner                 |
| Compensation     | `maximum_withdraw - principal_capacity` is paid only to the committed payout lock                                                        |
| Executor rewards | One fixed per-action reward is capped, pre-funded in the Job Cell, and separate from principal                                           |
| Network fees     | Executors provide fee inputs; the policy never silently reduces principal or compensation for fees                                       |
| Phase-one timing | An absolute epoch `since` enforces the lower bound; an approved executor set and operational cutoff manage the unenforceable upper bound |
| Phase two        | Claim, compensation payout, principal re-deposit, and successor creation occur atomically                                                |
| Recurrence       | Exactly one successor may be created while cycles and reward budget remain; otherwise the automation terminates                          |
| Source of truth  | CKB cells, headers, transaction status, and script validation are authoritative; clocks and queues are wake-up hints                     |
| Release posture  | Testnet pilot remains visibly unaudited until an independent contract review is complete                                                 |

CKB `since` is a not-before rule; it cannot make phase one expire after the ideal preparation
window. If the safe cutoff is missed, the executor must stop, discard the pending attempt, and
recalculate the next 180-epoch boundary. A late phase-one broadcast is a timing risk, so the first
pilot restricts that transition to an owner-approved executor set.

## 4. On-Chain Model

### 4.1 Harvest policy data

Add a canonical immutable Molecule payload committed by the existing Job Cell:

```text
table DaoHarvestPayloadV1 {
  version: Uint16,
  owner_lock_hash: Byte32,
  payout_lock_hash: Byte32,
  vault_lock_hash: Byte32,
  dao_type_hash: Byte32,
  principal_capacity: Uint64,
  prepare_executor_set_hash: Byte32,
  executor_reward: Uint64,
  min_compensation: Uint64,
  prepare_buffer_epochs: Uint64,
  confirmation_margin_epochs: Uint64,
  total_cycles: Uint32,
  end_epoch_since: Uint64,
}
```

The final schema must define byte order, hash domains, optional-field encoding, supported versions,
and exact epoch encodings. Mutable progress remains in `JobDataV1`: sequence, remaining actions,
budget, lower bound, immutable end epoch, and trigger commitment. Setup derives exactly two actions
per selected harvest cycle. The co-spent DAO cell data proves deposited or withdrawing state, and
the stable vault lock binds it to the job, so changing state and outpoints do not weaken the
immutable payload commitment. The first pilot commits a sorted set of no more than eight executor
lock hashes; a later version may replace it with a Merkle or SMT root.

### 4.2 Authoritative on-chain states

```text
DEPOSITED -> WITHDRAWING -> DEPOSITED
    |              |            |
    +--------------+------------+----> OWNER_EXIT
                                   `-> COMPLETED
```

`PREPARE_READY`, `PREPARE_SUBMITTED`, `CLAIM_READY`, `ROLL_SUBMITTED`, `CONFLICTED`, and
`RECOVERY_REQUIRED` are derived index/executor states. They must not be serialized as authoritative
states unless a contract transition needs them.

### 4.3 Required invariants

1. The automated path cannot send principal to the executor or payout address.
2. Phase one creates the required withdrawing DAO cell at the same output index and capacity.
3. Phase one pays only the committed executor reward to a proven approved executor.
4. Phase two consumes the exact withdrawing cell and required deposit/withdraw headers.
5. Phase two creates a new DAO deposit with eight zero data bytes and exactly the committed
   principal capacity.
6. Phase two sends exactly the allowed compensation to the committed payout lock.
7. Phase two pays no more than the committed executor reward.
8. A non-final transition creates exactly one successor with `sequence + 1` and
   `remaining_runs - 1`; every full harvest cycle consumes exactly two actions.
9. No successor is allowed after the end epoch, with zero cycles, or with insufficient reward
   budget.
10. Cancellation and recovery pay no executor reward and cannot depend on the hosted API.

## 5. Scheduling and Economics

Use exact epoch fractions rather than calendar-day arithmetic:

```text
deposit_position = deposit_epoch_number
                 + deposit_epoch_index / deposit_epoch_length

next_boundary = deposit_position + 180 * k
where k is the smallest positive integer whose boundary is after the current tip

prepare_start  = next_boundary - configured_buffer
prepare_cutoff = next_boundary - minimum_confirmation_margin
```

Before phase one, the service must show:

- original amount;
- currently accrued and projected compensation;
- the fixed executor reward and total funded action budget;
- estimated time outside the DAO;
- estimated net user benefit;
- the preparation window and its uncertainty; and
- a warning when the projected compensation is below `min_compensation`.

After phase one confirms, the claim epoch must be recalculated from the actual inclusion header.
No stored wall-clock estimate may authorize phase two.

## 6. Delivery Rules

Each numbered stage below is a separate implementation and audit unit. For every stage:

1. implement only the stated scope;
2. add focused positive, negative, and boundary tests;
3. run affected package checks plus `git diff --check`;
4. review authorization, value conservation, integer handling, stale inputs, and reorg behavior;
5. fix every finding before moving to the next dependent stage;
6. distinguish fixtures, local-chain evidence, and public-testnet evidence; and
7. do not commit unless the repository owner explicitly requests it.

If commits are later requested, do not use the word `phase` in a commit message.

---

## 7. Phased Implementation

### Phase 00: Freeze Scope and Threat Model

**Depends on:** None

**Implement:** Write the feature acceptance criteria, user authority statement, misuse cases, trust
boundaries, testnet-only banner, and the exact difference between compensation harvesting and yield
improvement. Record the new-deposit-only limitation and the approved phase-one executor trust.

**Verify:** Contract, backend, executor, and frontend requirements agree on the two-transition flow,
owner exit behavior, fee source, and immutable fields.

**Exit gate:** No requirement depends on custody, a future raw signature, a calendar-only trigger,
or an undefined claim of automatic compounding.

### Phase 01: Finalize Schema, State Machine, and Fixtures

**Depends on:** Phase 00

**Implement:** Add `DaoHarvestPayloadV1`, state and error constants, payload hashing, executor-set
commitment, transition diagrams, canonical JSON fixtures, and generated Rust/TypeScript codecs.
Define setup, prepare, claim/redeposit, terminal, cancellation, and recovery transaction layouts.

**Verify:** Rust and TypeScript encode identical bytes and hashes. Mutation fixtures cover every
policy field, integer boundary, output ordering rule, reward, cycle counter, and state transition.

**Exit gate:** Every byte and permitted transition has one versioned definition with cross-language
conformance evidence.

### Phase 02: Implement and Prove the On-Chain Policy

**Depends on:** Phase 01

**Implement:** Add the Harvest Vault Lock and DAO Harvest Policy. Implement owner and automation
paths; principal preservation; approved phase-one executor proof; DAO prepare output validation;
claim header, witness, and `since` validation; exact compensation payout; atomic re-deposit;
bounded rewards; one-successor recurrence; and terminal owner exit.

**Verify:** `ckb-testtool` tests prove valid setup, prepare, roll, completion, cancellation, and
recovery. Adversarial tests reject principal diversion, payout substitution, early claim, early or
unauthorized preparation, header substitution, reward inflation, duplicate successors, cycle
increase, fake owner inputs, and malformed DAO data. Run property tests, fuzz harnesses, cycle
benchmarks, reproducible builds, and an independent manual review.

**Exit gate:** No critical or high-severity finding remains; measured cycles and occupied capacity
fit documented limits; deployed binaries reproduce byte-for-byte.

### Phase 03: Add DAO Math and Transaction Builders

**Depends on:** Phases 01-02

**Implement:** In shared packages, add exact epoch-fraction comparison, next-boundary calculation,
prepare-window selection, DAO maximum-withdraw calculation, economics quotation, and builders for
setup, prepare, claim/redeposit, stop-recurrence, owner exit, and recovery. Reuse CCC DAO helpers
where they produce the required values, with independent fixture verification.

**Verify:** Published DAO examples and local fixtures match the canonical calculations. Builders
reject stale outpoints, wrong networks, insufficient occupied capacity, mismatched headers,
unsafe payout changes, fee deductions from principal, and expired quotes.

**Exit gate:** Every builder returns a deterministic transaction, signing entries, normalized
human-readable intent, and independently verifiable policy hash.

### Phase 04: Extend the Read Model and API

**Depends on:** Phase 03

**Implement:** Add database migrations and indexing for harvest jobs, vault DAO cells, exact epochs,
phase-one headers, claim maturity, cycle counters, economics snapshots, and transition attempts.
Add typed read, quote, setup, cancellation, exit, and recovery endpoints; regenerate OpenAPI and the
client package.

**Verify:** Indexing reconstructs state from CKB after an empty database, rolls back reorged
prepare/claim transactions, deduplicates rediscovery, paginates all jobs, and never reports a
derived state as confirmed without canonical-chain evidence. API integration tests cover malformed
addresses, cross-network records, stale quotes, unavailable RPC, and partial service failure.

**Exit gate:** The complete automation state can be rebuilt from chain data and every mutation
endpoint returns unsigned transaction data only.

### Phase 05: Implement Executor Scheduling and Transitions

**Depends on:** Phases 02-04

**Implement:** Add the DAO harvest adapter and durable work queues. Discover eligible jobs, calculate
the exact prepare window, enforce the approved executor identity, simulate before submission, stop
at the preparation cutoff, track confirmations, calculate claim maturity from the confirmed header,
build phase two, and create the next-cycle successor when allowed.

**Verify:** Tests cover early wake-ups, missed cutoffs, boundary rollover, spent inputs, stale fees,
RPC disagreement, dropped and replaced transactions, multiple executors, reorgs of either phase,
restart recovery, insufficient reward budget, and terminal cycles. No retry path may broadcast a
phase-one transaction after its cutoff.

**Exit gate:** Replaying queues or running two executors cannot create two valid rewards, duplicate
successors, a late preparation attempt, or a false completed state.

### Phase 06: Build the CKAutomata User Experience

**Depends on:** Phase 04

**Implement:** Replace the research-only entry with a live testnet `Harvest compensation` template.
Build a short setup flow for title, original amount, payout address, one-time or finite recurrence,
and review. Show a simple fee total while preserving a technical disclosure for separate executor
rewards and estimates. Add wallet-approved setup, progress, dashboard row, detail timeline,
compensation history, stop, exit, and recovery screens.

**Verify:** Component and browser tests cover disconnected and unsupported wallets, address
validation, insufficient balance, changed quotes, rejected signatures, loading/error states,
mobile layout, keyboard navigation, and transaction resumption after refresh. The wallet review
must independently decode and compare the transaction against the displayed intent.

**Exit gate:** A nontechnical test user can explain what remains deposited, what becomes liquid,
what authority is granted, what fees are paid, and how to exit before signing.

### Phase 07: Complete Owner Recovery and Operations

**Depends on:** Phases 03-06

**Implement:** Extend the recovery CLI and published SDK for deposited, withdrawing, claim-ready,
budget-exhausted, deprecated, and service-unavailable states. Add notifications, signed receipts,
metrics, alerts, dead-letter inspection, executor pause controls, and runbooks for missed windows,
reorgs, RPC outages, and script deprecation.

**Verify:** Recover or exit using only a fresh checkout, public chain access, deployment manifests,
the owner's wallet, and published artifacts. Stop the API, Redis, database, and executor in turn and
confirm owner recovery remains available.

**Exit gate:** No owner exit depends on CKAutomata's hosted services, private database, or operator
cooperation.

### Phase 08: Run Integrated Security and Failure Testing

**Depends on:** Phases 02-07

**Implement:** Add full local-chain journeys for setup through multiple harvest cycles, final
completion, stop-recurrence, and owner exit. Run threat-model review, dependency and secret scans,
contract fuzzing, API abuse tests, executor contention, reorg drills, accessibility checks, and
wallet/browser tests.

**Verify:** Demonstrate value conservation from initial setup through every output; compare indexed
state to chain state after each transition; test the smallest supported principal and maximum
supported cycles; and review all wallet signing summaries against actual serialized transactions.

**Exit gate:** All automated checks pass, all critical and high findings are fixed, and remaining
known limitations have explicit owners and user-facing disclosures.

### Phase 09: Deploy and Accept the Testnet Pilot

**Depends on:** Phase 08

**Implement:** Deploy reproducible vault and policy binaries to testnet, publish code hashes and
cell deps, register the deployment in API/executor/web manifests, fund capped executor wallets,
activate the feature flag, and publish recovery artifacts. Run a multi-cycle accelerated local test
and at least one real testnet cycle using live headers and transactions.

**Verify:** A wallet creates an automation, an approved executor prepares within the measured
window, the second transition claims and atomically re-deposits the exact original amount, the
compensation reaches the configured payout address, the UI follows canonical status, and the owner
can independently stop and exit. Complete a seven-day service soak in addition to the real DAO
cycle evidence.

**Exit gate:** Testnet evidence includes transaction hashes, headers, decoded outputs, balances,
receipts, recovery proof, monitoring results, and a signed acceptance checklist. Mainnet remains
disabled until a separate audit and launch decision.

## 8. Final Acceptance Checklist

- The setup transaction grants only the documented harvest policy authority.
- Phase one cannot change principal, payout address, vault policy, or rewards.
- Phase one is never submitted before `prepare_start` or after `prepare_cutoff` by compliant
  executors.
- Missing a preparation window rolls the job to the next boundary without fixing compensation
  late.
- Phase two uses the confirmed phase-one header and a valid mature absolute epoch `since`.
- Phase two atomically re-deposits exactly the original amount and pays only compensation to the
  configured address.
- Rewards and network fees never reduce protected principal.
- One successful cycle creates at most one successor.
- Owner cancellation, exit, and recovery work without hosted CKAutomata services.
- Reorgs, contention, restarts, and stale inputs do not create false completion or duplicate
  payment.
- The interface describes harvesting as periodic liquidity, not additional yield.
- Testnet deployment artifacts and recovery instructions are public and reproducible.

## 9. Normative References

- [Nervos RFC 23: Deposit and Withdraw in Nervos DAO](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md)
- [Nervos RFC 17: Transaction `since` Precondition](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0017-tx-valid-since/0017-tx-valid-since.md)
- [CKB Nervos DAO system script](https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/dao.c)
- [NervDAO reference implementation](https://github.com/ckb-devrel/nervdao)
