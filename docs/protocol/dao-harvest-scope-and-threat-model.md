# DAO Harvest Scope and Threat Model

Status: Accepted for implementation

Network: CKB testnet only

Feature: CKAutomata Harvest compensation

Protocol version: Draft V1

## Product promise

Harvest compensation periodically makes accrued Nervos DAO compensation liquid while preserving
the user's chosen original amount in a new DAO deposit.

After one owner-approved setup transaction, each successful cycle has two on-chain transitions:

1. An approved executor prepares the DAO withdrawal near the next eligible 180-epoch boundary.
2. After maturity, an executor claims the withdrawing cell, sends the compensation to the owner's
   selected payout address, and atomically creates a new DAO deposit containing exactly the
   original amount.

The owner approves a constrained on-chain policy. The owner does not give CKAutomata a private key,
seed phrase, wallet session, unrestricted signature, or permission to construct arbitrary wallet
transactions.

Harvesting is a cash-flow feature. Nervos DAO compensation already compounds while a deposit
remains deposited. CKAutomata must not describe harvesting as a yield increase, fixed return, or
guaranteed monthly payment.

## Pilot scope

The pilot supports:

- new CKB testnet DAO deposits created under the Harvest Vault Lock;
- one immutable original amount and one immutable compensation payout lock per automation;
- one harvest or a finite number of recurring harvests;
- exact rational-epoch scheduling from canonical CKB headers;
- one separately pre-funded and capped executor reward per on-chain action;
- owner-approved setup, stop, exit, and recovery transactions; and
- public transaction, status, failure, and recovery evidence.

The pilot does not support:

- mainnet funds or claims of production readiness;
- migration of an existing standard-lock DAO deposit;
- infinite recurrence;
- mutable original amount, payout address, or rewards without a new owner authorization;
- fees or rewards deducted from the protected original amount;
- arbitrary scheduled wallet actions; or
- a guaranteed execution time, compensation amount, or financial return.

Existing standard-lock deposits require a later migration design. They cannot be silently treated
as vault-controlled deposits because the existing lock still requires its owner's authorization.

## Plain-language authority statement

The setup transaction gives the automation only enough authority to:

- prepare the selected DAO deposit for withdrawal;
- claim that same withdrawing cell after it becomes mature;
- return exactly the selected original amount to a new DAO deposit;
- send only the resulting compensation to the selected payout address;
- pay no more than the disclosed fixed reward for each action; and
- repeat no more than the selected number of times and never beyond the selected end epoch.

The automation cannot change the payout address, reduce or redirect the original amount, increase
its rewards, add cycles, spend unrelated wallet cells, or prevent the owner from using a valid exit
or recovery path.

Every owner path requires a distinct co-spent wallet input whose full lock-script hash equals the
owner lock hash committed during setup. A database account, API session, or address string alone is
never owner authorization.

The first transition has an operational timing trust. CKB `since` can prevent execution before the
preparation window, but it cannot make a signed or policy-valid transition expire after a cutoff.
The pilot therefore permits only an owner-approved executor set to perform the first transition.
Those executors are trusted to stop after the cutoff. They are not trusted with custody, payout
selection, or principal allocation.

## Trust boundaries

| Component                                 | Trusted for                                                        | Not trusted for                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| CKB consensus and Nervos DAO script       | Transaction validity, maturity, DAO compensation limit             | Timely inclusion or application availability                                         |
| Harvest Vault Lock and DAO Harvest Policy | Enforcing authority, outputs, rewards, recurrence, and owner paths | Executor availability or correct UI wording                                          |
| Owner wallet                              | Setup, stop, exit, recovery, and co-spent owner authorization      | Background execution while disconnected                                              |
| Approved prepare executor                 | Submitting phase one only within the safe window                   | Custody, output selection, reward changes, or late-broadcast prevention by consensus |
| Roll executor                             | Building and submitting a valid mature claim/redeposit transaction | Custody, payout selection, or recurrence changes                                     |
| API and PostgreSQL read model             | Convenient quotes, discovery, history, and unsigned builders       | Authoritative chain state or signing authority                                       |
| Redis and BullMQ                          | Durable wake-ups and retries                                       | Trigger proof or protocol state                                                      |
| Web application                           | Clear intent review and wallet coordination                        | Bypassing contract validation                                                        |
| Wall clock and cron                       | Approximate display and service wake-up                            | DAO eligibility or maturity evidence                                                 |

## Value and fee rules

- `principal_capacity` is the exact full capacity of the vault DAO cell, not a floating-point CKB
  amount and not a minimum.
- Phase one preserves that capacity exactly in the withdrawing DAO cell.
- Phase two creates a new DAO deposit with exactly `principal_capacity`.
- Gross compensation is `maximum_withdraw - principal_capacity` using canonical deposit and
  phase-one headers.
- The complete gross compensation is sent to the committed payout lock in V1.
- The fixed reward for each prepare or roll action comes from the separately funded Job Cell.
- Executor network fees come from executor-owned fee inputs.
- The pilot has no protocol fee and may not silently deduct any charge from principal or
  compensation.

The UI may group the funded executor rewards and estimated setup network fee under the simple label
`Automation charges`, but its technical details must preserve the separate values and fee source.

## Scheduling rules

Eligibility uses exact epoch number, index, and length from canonical CKB headers. Calendar dates
are estimates for people and never trigger execution.

For every deposited state:

1. Calculate the next boundary at the same fractional epoch position plus a positive multiple of
   180 epochs.
2. Derive a preparation start and operational cutoff from the configured safety margins.
3. Do not submit before the start.
4. Stop building, retrying, and submitting phase one at the cutoff.
5. If the cutoff is missed, roll forward to the next boundary instead of preparing immediately.
6. After phase one reaches the configured confirmation depth, calculate claim maturity from its
   actual inclusion header.
7. Submit phase two only when its absolute epoch `since` is mature.

Confirmation depth is an application finality policy. It does not alter CKB consensus or make a
confirmed transaction immune to a deeper reorganization.

## Misuse cases and controls

| Misuse or failure                                | Required control                                                               | Residual risk                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Executor redirects original amount               | Exact withdrawing and re-deposit capacity, lock, type, and data checks         | Contract implementation defect                        |
| Executor redirects compensation                  | Immutable payout lock and exact payout validation                              | Owner approved the wrong address                      |
| Executor increases its reward                    | Exact phase-specific reward and Job Cell conservation                          | Contract implementation defect                        |
| Executor submits phase one too early             | Absolute epoch `since` and policy checks                                       | Incorrect configured lower bound                      |
| Approved executor submits phase one after cutoff | Restricted executor set, queue cutoff, alert, and operational audit            | Approved executor can deliberately grief timing       |
| Missed boundary                                  | Safety margin, redundant executors, and automatic next-cycle rollover          | Congestion or reorg can still miss inclusion          |
| Phase two is attempted early                     | DAO validation and exact absolute epoch `since`                                | Wall-clock estimate may be later than expected        |
| Wrong deposit or phase-one header                | Header/outpoint commitments and DAO witness validation                         | Parser or contract defect                             |
| Duplicate cycle or successor fork                | Consumed-cell uniqueness, sequence increment, and exactly-one-successor checks | Competing attempts waste executor fees                |
| Reward theft from mempool                        | Bind reward to the proven executor input identity                              | Propagation and contention remain                     |
| Owner cancellation races execution               | Normal CKB input contention and explicit pending state                         | One valid transaction wins; the other fails           |
| Phase-one reorg after phase two is built         | Confirmation gate, canonical-header check, and rebuild                         | Deep reorganization delays progress                   |
| Fee input becomes stale                          | Rebuild only executor fee inputs before signing and simulation                 | Temporary service delay                               |
| Job reward budget is exhausted                   | Profitability and budget gate; owner exit remains available                    | Automation has no liveness until funded or exited     |
| API, database, or Redis is compromised           | On-chain checks, local wallet review, replay from chain                        | Phishing UI can still mislead a user before signing   |
| Executor fee key is compromised                  | Testnet-only capped balance and no owner authority                             | Operator funds and availability can be lost           |
| Script version becomes unsupported               | Versioned manifests, pause, owner recovery, reproducible binaries              | Migration still requires owner action                 |
| Unsupported wallet cannot explain setup          | Feature gate and plain-language review                                         | Fewer wallets are available during the pilot          |
| UI implies harvesting improves yield             | Required cash-flow wording and content tests                                   | External descriptions remain outside protocol control |

## Required owner paths

| On-chain state                    | Owner action                                         | Result                                                         |
| --------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| Deposited, before phase one       | Stop recurrence or begin owner withdrawal            | No future automated cycle; principal remains owner-recoverable |
| Prepare submitted but unconfirmed | Submit a conflicting owner path if still valid       | CKB input contention selects one transaction                   |
| Withdrawing, before maturity      | Stop future recurrence                               | Current withdrawal cannot be undone; owner waits for maturity  |
| Claim-ready                       | Exit instead of re-deposit                           | Original amount and compensation return under the owner policy |
| Reward budget exhausted           | Refill through a separately approved path or exit    | No unpaid executor authority is created                        |
| Unsupported or deprecated version | Use the published recovery transaction and artifacts | No executor-controlled migration                               |

Every owner path must be constructible from a fresh checkout and public chain data without the
hosted API, PostgreSQL, Redis, or an Automata operator.

## Acceptance ownership and evidence

| Area                        | Responsible role  | Acceptance evidence                                                      |
| --------------------------- | ----------------- | ------------------------------------------------------------------------ |
| Product wording and scope   | Product owner     | This document, setup review copy, and nontechnical usability record      |
| Schemas and protocol        | Protocol owner    | Molecule source, cross-language fixtures, transition specification       |
| Vault and policy scripts    | Contract owner    | CKB-VM tests, mutation tests, fuzzing, cycle report, reproducible hashes |
| DAO math and builders       | SDK owner         | RFC/CCC differential fixtures and serialized transaction vectors         |
| Index and API               | Backend owner     | Empty-database replay, reorg tests, OpenAPI, unsigned-response tests     |
| Scheduling and submission   | Executor owner    | Cutoff, contention, restart, stale-input, and missed-boundary evidence   |
| Wallet review and status UI | Frontend owner    | Component, accessibility, responsive, and wallet journey evidence        |
| Independent exit            | Recovery owner    | Fresh-checkout stop, exit, and recovery drill                            |
| Public testnet pilot        | Release owner     | Deployment manifest, transaction hashes, decoded outputs, soak report    |
| Security release decision   | Security reviewer | Findings report with no unresolved critical or high issue                |

## Pilot acceptance criteria

The feature is accepted for public testnet only when all of the following are demonstrated:

- One setup transaction creates the intended vault DAO cell and funded harvest Job Cell.
- A compliant executor never submits phase one outside its calculated preparation window.
- Phase one preserves the exact original amount and changes only the permitted DAO/job state.
- Phase two uses the canonical deposit and phase-one headers and a mature `since` value.
- Phase two atomically re-deposits the exact original amount and sends the exact compensation to
  the configured payout lock.
- Concurrent executors cannot earn twice or create two successors.
- A reorg, dropped transaction, stale fee input, restart, or missed boundary converges to an honest
  state without false completion.
- Owner stop, exit, and recovery work in every on-chain state without hosted services.
- The wallet review accurately describes the serialized setup transaction and worst-case timing
  authority.
- A nontechnical user can identify the original amount, compensation address, automation charges,
  next action, and exit path without understanding cells, witnesses, or epochs.
- Public evidence separates local fixtures, local-chain runs, and real testnet transactions.
- No critical or high-severity finding remains unresolved.

Mainnet remains disabled until a separate decision includes an independent audit, remediation,
shadow execution evidence, capped launch policy, incident plan, and current economic review.

## Normative references

- [DAO Harvest implementation plan](../../DAO_HARVEST_IMPLEMENTATION.md)
- [CKB Automata full project documentation](../../CKB_AUTOMATA_FULL_PROJECT_DOCUMENTATION.md)
- [Nervos RFC 23: Deposit and Withdraw in Nervos DAO](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md)
- [Nervos RFC 17: Transaction `since` Precondition](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0017-tx-valid-since/0017-tx-valid-since.md)
- [CKB Nervos DAO system script](https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/dao.c)
