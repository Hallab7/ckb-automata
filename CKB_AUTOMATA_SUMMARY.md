# CKB Automata: Project Summary

> Policy-constrained execution for CKB applications.

**Research snapshot:** 21 September 2026  
**Status:** Research and validation; not deployed or audited  
**Full specification:** [CKB_AUTOMATA_FULL_PROJECT_DOCUMENTATION.md](./CKB_AUTOMATA_FULL_PROJECT_DOCUMENTATION.md)

## Project Decision

CKB Automata should be built as a shared execution layer for CKB applications. It should not begin
as a generic scheduling dashboard, a NervDAO-only product, or a service that stores user private
keys.

CKB scripts verify transactions but do not wake themselves, monitor deadlines, construct
transactions, submit them, retry after failure, or pay operators. Applications currently solve
this liveness problem with manual actions or bespoke keepers. Automata turns that repeated work
into a standard protocol:

1. A funded **Job Cell** records the trigger, permitted action, reward, budget, sequence, and
   recurrence.
2. A narrow policy script constrains every valid output and value movement.
3. An executor discovers the job, builds and simulates the transaction, broadcasts it, and handles
   retries and reorgs.
4. The action, executor reward, and optional successor job settle atomically.

Executors never receive a general user or application key.

## Automation Families

An automation family describes the shared operational lifecycle. It is separate from the trigger
evidence and from the application-specific policy that constrains the transaction.

| Family | Typical work | CKB evidence | Release posture |
|---|---|---|---|
| Deadline finalization | Finalize, release, refund, or close after a lower-bound deadline | CKB Kickstarter, CKBoost | **V1** |
| Recurring distribution | Pay bounded recipients and create one successor job | CCC Schedule Send, CKBoost rewards | **V1** |
| State transition and batching | Consume compatible instruction cells and retry contention | .bit / DAS | **V1**, narrow predicates |
| Multi-stage maturity | Continue deposit, withdrawal, vesting, or claim workflows | NervDAO, iCKB | Pilot after policy review |
| Human-gated continuation | Execute a payout only after a verifiable approval | PactAgent, CKBoost tips | V1 only when approval is already committed |
| Maintenance and cleanup | Expire orders, reclaim capacity, compact or settle state | iCKB limit orders, future marketplaces | Later; economics required |
| Condition-triggered risk action | Liquidate, repay, top up, or rebalance against valid state | Stable++ | Later; oracle and value-at-risk review |
| Cross-layer operational settlement | Close, recover, sweep, or reconcile external/Fiber state | LiquidLane | Later; custody and credentials unresolved |

V1 should prove deadline finalization and recurring distribution with the same Job Cell lifecycle.
A third narrow state-transition adapter is useful when an external partner's existing scripts
already authorize permissionless execution.

## CKB Application Evidence

| Application or project | Existing automation need | Verified status and boundary |
|---|---|---|
| [.bit / DAS](https://talk.nervos.org/t/das-ckb-keeper/5700) | Permissionless keepers batch instruction cells, retry contention, and receive fees | Historical 2021 architecture precedent; not a current integration commitment |
| [CKB Kickstarter](https://talk.nervos.org/t/introducing-ckb-kickstarter-decentralized-all-or-nothing-crowdfunding-on-nervos-ckb-testnet-mvp-live/10130) | Polls for expired campaigns, finalizes them, and releases or refunds pledges | Bot reported live and end-to-end verified on testnet in April 2026; external review and mainnet were still pending |
| [PactAgent](https://talk.nervos.org/t/pactagent-from-application-to-infrastructure/10352) | Workers handle deadlines, settlement, retries, stale locks, and audited replay | Active application/infrastructure work; human review and disputes stay outside Automata |
| [CCC Schedule Send](https://github.com/ckb-devrel/ccc-schedule-send) | Dedicated backend schedules token distributions and tracks retries/status | Developer reference backend; public production usage was not established |
| [iCKB / NervDAO](https://ickb.org/) | DAO receipt conversion, staggered maturities, withdrawals, and order cleanup | iCKB exposes mainnet/testnet use; Automata compatibility is unproven |
| [CKBoost](https://talk.nervos.org/t/dis-ckboost-gamified-community-engagement-platform-proposal/8832) | Time-bounded campaigns, funded rewards, approvals, and tipping payouts | [Community Catalyst reported the testnet application live](https://talk.nervos.org/t/nervos-community-catalyst-quarterly-reports/8822/3); subjective proof approval must remain human-gated |
| [Stable++](https://stablepp.gitbook.io/stable++/) | Collateral vaults require timely liquidation | [Nervos Foundation reported an October 2024 mainnet launch](https://www.nervos.org/assets/pdfs/2024_Nervos_Foundation_Year-end_Report.pdf); oracle proof and current contract entry points require verification |
| [LiquidLane](https://talk.nervos.org/t/liquidlane-lp-backed-fiber-channel-liquidity/10686) | Lease expiry requires channel settlement, recovery, and vault reconciliation | Testnet prototype only; its Spark proposal was rejected over custody and recovery concerns |

These are evidence of repeated liveness work, not signed Automata adopters. A project counts as a
design partner only after written maintainer intent and a verified compatible authorization path.

## NervDAO Reference Workflow

NervDAO remains a useful, deeply researched candidate rather than the predetermined first product:

- **DAO Cycle Guard** calculates exact epoch boundaries, warns before the ideal withdrawal window,
  optionally broadcasts a wallet-approved phase-one transaction, and tracks the later manual claim.
- **Harvest Compensation** is an advanced policy-vault pilot. After one explicit setup approval:

1. The configured principal is deposited in Nervos DAO under an audited Harvest Vault Lock.
2. An approved executor prepares withdrawal near the next 180-epoch boundary.
3. After maturity, any valid executor claims the DAO cell.
4. The same transaction sends accrued compensation to the user's payout address.
5. The configured principal is redeposited into Nervos DAO.
6. A successor Job Cell repeats the cycle until the cycle limit, expiry policy, budget limit, or
   owner cancellation is reached.

The user retains an owner-signed cancellation and recovery path. Existing standard-lock DAO
deposits need a separate migration flow; V1 should initially support new deposits only.

Neither feature should enter the shared roadmap until maintainers validate demand, integration
acceptance is plausible, and measured economics justify the additional policy risk.

## Important DAO Findings for the Candidate

- A Nervos DAO withdrawal has two phases: prepare withdrawal, then claim after the relevant
  180-epoch boundary, approximately 30 days.
- Compensation stops accruing when phase one is included, so preparing too early reduces the
  user's compensation.
- Missing the intended boundary may make the user wait another cycle.
- Phase two needs the actual block header that includes phase one. That header is unknown at setup,
  so both transactions cannot simply be fully signed weeks in advance.
- CKB `since` enforces a not-before condition, not an expiry. It cannot make phase one invalid after
  the ideal window closes.
- Because late phase-one execution can harm the user, V1 must restrict phase one to a user-approved
  executor set. Phase two can be permissionless because its outputs are fixed and earlier valid
  execution is beneficial.
- A future fully permissionless phase-one design would need a verifiable freshness proof,
  bonded/slashable execution, or new protocol support.

## Compensation and Economics

The product must not advertise "2% monthly." At the researched mainnet snapshot, the recent change
in the DAO accumulated-rate field simple-annualized over a 365-day year to approximately **2.05%
per year**, not per month. This short-window estimate is not a guaranteed APY; the exact
compensation is calculated from the deposit and phase-one block headers.

Nervos DAO already effectively compounds compensation while funds remain deposited. Harvesting is
therefore a cash-flow feature, not a yield enhancement. It lets a user make compensation liquid
while rolling the principal into a new deposit.

For illustration, if `100,000 CKB` of profitable capacity earned 2.05% annually at a constant rate,
gross compensation would be about `2,050 CKB` per year or approximately `171 CKB` per 30-day cycle.
The user's economic benefit must subtract:

- phase-one and phase-two executor rewards;
- any explicitly disclosed protocol fee;
- network-cost assumptions; and
- compensation lost between phase-one preparation and redeposit.

Executor rewards must be pre-funded in the Job Cell. They must not reduce the configured principal
or be silently deducted from harvested compensation. The UI should recommend a longer cadence or
no harvesting when the projected benefit is below the user's minimum payout.

## Candidate Harvest Security Rules

The Harvest Vault and Job scripts must enforce:

- exact preservation and redeposit of the configured principal;
- an immutable compensation payout address;
- a fixed or capped executor reward;
- an approved executor identity for phase one;
- the correct DAO deposit and withdrawal headers;
- the correct absolute epoch `since` for phase two;
- exactly one successor with the same job identity and `sequence + 1`;
- no replay, duplicate execution, or successor fork;
- no policy or payload replacement;
- no reward for cancellation; and
- an owner-controlled exit and recovery path.

The main residual risk is a compromised approved phase-one executor deliberately submitting late.
It cannot steal funds if the scripts are correct, but it can harm timing. At least two independent
approved operators should be used, and this timing trust must be disclosed during setup.

## System Components

CKB Automata requires:

| Component | Responsibility |
|---|---|
| Job protocol | Versioned Molecule schema and lifecycle rules |
| Job and policy scripts | Trigger, value, reward, recurrence, cancellation, and recovery checks |
| Optional policy vaults | Owner path plus narrowly constrained automation path when an application requires delegated custody |
| TypeScript SDK | Job creation, quoting, cancellation, recovery, inspection, and CCC integration |
| Adapter kit | Deterministic builders for DAO, campaign, distribution, and other actions |
| Rust executor | Discovery, eligibility, simulation, submission, retry, and reorg handling |
| Index API | Verifiable read model, events, quotes, and webhooks |
| Console | Public job, transaction, failure, and executor inspection |
| Application integrations | Embedded setup, status, cancellation, recovery, and application-specific explanations |

The chain remains the source of truth. Indexer results and webhooks are notifications, not trigger
proofs.

## V1 Scope

The first reusable policies should cover:

1. Campaign or escrow deadline finalization with deterministic release/refund outputs.
2. Finite recurring CKB or xUDT distribution with fixed recipients, caps, and one successor.
3. Optionally, one narrow instruction-cell batching workflow with an external partner.

DAO harvesting, auctions, order cleanup, collateral maintenance, signed API events, and Fiber
operations follow only after their application-specific trust, timing, and economic risks are
measured. Detailed design work does not make any one of them the first product automatically.

## Explicit Non-Goals

- Holding seed phrases, private keys, or unrestricted session keys.
- Scheduling arbitrary wallet transactions.
- Promising a fixed DAO return.
- Building a general oracle network.
- Cross-chain or Fiber automation in V1.
- A protocol token, staking market, or governance system.
- Mainnet claims before an independent audit and sustained testnet evidence.

## Delivery Plan

### Gate A: prove demand and mechanics

- Interview at least five CKB teams.
- Obtain three independent integration commitments.
- Prototype one deadline workflow and one recurring or state-transition workflow.
- Measure occupied capacity, script cycles, transaction costs, contention, and reward economics.
- Demonstrate cancellation and owner recovery for every funded policy.
- Treat Cycle Guard and Harvest Vault as optional NervDAO work contingent on maintainer demand.

### Gate B: build the shared protocol

- Finalize schemas, Job Lock, reference policies, and any partner-required constrained vault.
- Publish TypeScript/CCC SDKs and a Rust executor.
- Add retry, conflict, reorg, failure classification, API, webhooks, and console.
- Integrate three independent applications across at least two automation families.
- Run publicly on testnet for at least 30 consecutive days.
- Complete an independent audit, remediation, and mainnet shadow run.
- Begin mainnet only with capped, audited pilot jobs.

## Success Criteria

Proceed to production funding and mainnet only when:

- three independent applications have merged integrations;
- at least two action classes use the same Job Cell lifecycle;
- concurrent executors cannot duplicate transitions or redirect rewards;
- principal and payout invariants pass adversarial and property tests;
- every live state has a documented owner recovery path;
- dropped, conflicted, and reorged transactions recover correctly;
- a third party can reproduce contracts and run an executor;
- no critical or high-severity audit finding remains; and
- every selected workflow has positive measured execution economics for a defined operating range.

Stop or narrow the project if teams prefer existing keepers, recovery is too complex, wallets
cannot explain delegated authority, every integration needs different semantics, or only
builder-owned projects adopt it. If only one application validates the model, ship its local
worker improvement without claiming a shared execution protocol.

## Recommendation

Build the first two integrations with committed external applications from different automation
families. Do not begin with a large general-purpose protocol grant or assume NervDAO must be first.

The production protocol should proceed only after demand, non-custodial recovery, positive measured
economics, and independent security evidence are established. The core promise is narrow:

> CKB Automata lets applications pay operators to perform pre-authorized, verifiable future actions
> without giving those operators a general key.

## Primary References

- [Nervos DAO deposit and withdrawal RFC](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md)
- [CKB `since` RFC](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0017-tx-valid-since/0017-tx-valid-since.md)
- [Official DAO system script](https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/dao.c)
- [NervDAO source](https://github.com/ckb-devrel/nervdao)
- [CCC source](https://github.com/ckb-devrel/ccc)
- [.bit / DAS keeper design](https://talk.nervos.org/t/das-ckb-keeper/5700)
- [CKB Kickstarter and automatic finalization bot](https://talk.nervos.org/t/introducing-ckb-kickstarter-decentralized-all-or-nothing-crowdfunding-on-nervos-ckb-testnet-mvp-live/10130)
- [PactAgent worker and settlement architecture](https://talk.nervos.org/t/pactagent-from-application-to-infrastructure/10352)
- [CCC Schedule Send](https://github.com/ckb-devrel/ccc-schedule-send)
- [iCKB whitepaper](https://github.com/ickb/whitepaper)
- [CKBoost application proposal and updates](https://talk.nervos.org/t/dis-ckboost-gamified-community-engagement-platform-proposal/8832)
- [Stable++ documentation](https://stablepp.gitbook.io/stable++/)
- [Nervos Foundation 2024 report](https://www.nervos.org/assets/pdfs/2024_Nervos_Foundation_Year-end_Report.pdf)
- [LiquidLane prototype and review](https://talk.nervos.org/t/liquidlane-lp-backed-fiber-channel-liquidity/10686)
