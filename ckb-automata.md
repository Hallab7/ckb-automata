# CKB Automata

> Permissionless execution for CKB applications.

Research snapshot: **21 September 2026**  
Status: **pre-proposal; grant-worthy only after external demand is proven**

Project summary: [CKB_AUTOMATA_SUMMARY.md](./CKB_AUTOMATA_SUMMARY.md)  
Full product, protocol, automation-family, application-evidence, security, and delivery specification:
[CKB_AUTOMATA_FULL_PROJECT_DOCUMENTATION.md](./CKB_AUTOMATA_FULL_PROJECT_DOCUMENTATION.md)

## Decision

CKB Automata should be built as a shared execution layer, not as another dashboard, bot, or
single-purpose script.

CKB contracts can verify a state transition, but they cannot wake themselves up and submit the
transaction that causes it. Every application with deadlines, expiries, recurring actions, or
maintenance therefore needs an off-chain process. Today, each team has to operate that process
itself or leave the action to users.

Automata turns that repeated work into one CKB-native protocol:

1. An application publishes a funded **Job Cell** describing when an action becomes valid, which
   state transition is allowed, and how much a successful executor earns.
2. Independent executors observe eligible jobs and construct the required CKB transaction.
3. CKB scripts verify the trigger, permitted outputs, executor reward, and any successor job.
4. The action and payment settle atomically. No executor receives custody of an application or
   user key.

The useful product is not "cron on a blockchain." It is a common liveness layer that removes a
backend service from every CKB application that otherwise needs one.

Do **not** submit a large Community Fund DAO proposal for the raw idea. First obtain three written
integration commitments from independent CKB teams and prove two real workflows on testnet. If
that evidence exists, Automata is a credible public-infrastructure grant.

## The Problem

### CKB scripts validate; they do not initiate

A CKB lock or type script runs only when a transaction includes the relevant cell. It cannot:

- wake at a deadline;
- notice that another cell changed;
- construct and broadcast a transaction;
- retry after a rejected or orphaned transaction; or
- pay an operator for keeping the application live.

That is not a defect in CKB. It is the boundary between deterministic on-chain validation and
off-chain transaction generation. The gap becomes a product problem when every application builds
its own scheduler, key management, indexer loop, retry logic, and monitoring.

### The need already appears in CKB applications

This is not only a theoretical product category. CKB applications and developer projects already
run, propose, or document separate keepers, workers, scheduled senders, and settlement services:

| Application or project | Evidence of the liveness problem | Automation family | Evidence status |
|---|---|---|---|
| [.bit / DAS](https://talk.nervos.org/t/das-ckb-keeper/5700) | Its published design uses permissionless keepers to consume instruction cells, batch registrations, retry after cell contention, and earn part of the registration fee | State transition and batching | Historical design published in 2021; current operation was not re-verified and this is not an Automata commitment |
| [CKB Kickstarter](https://talk.nervos.org/t/introducing-ckb-kickstarter-decentralized-all-or-nothing-crowdfunding-on-nervos-ckb-testnet-mvp-live/10130) | A bot polls for expired campaigns, finalizes them, and releases or refunds pledge cells through permissionless contract paths | Deadline finalization and workflow continuation | Bot reported live and end-to-end verified on testnet on 27 April 2026; external review and mainnet remained future work in that update |
| [PactAgent](https://talk.nervos.org/t/pactagent-from-application-to-infrastructure/10352) | Independent workers handle settlement, deadlines, retries, stale locks, and audited replay for agreement and escrow workflows | Human-gated workflow continuation | Active application/infrastructure development; its deployed CKB lock rules still determine which steps can be automated |
| [CCC Schedule Send](https://github.com/ckb-devrel/ccc-schedule-send) | CKB DevRel built a dedicated backend for block-based scheduled token distribution, including status and retry handling | Recurring distribution | Developer reference backend; public production usage is not established |
| [iCKB and NervDAO](https://github.com/ickb/whitepaper) | DAO deposits, receipt conversion, pooled maturities, two-phase withdrawals, and limit orders require maturity-aware transaction construction | Multi-stage maturity and state maintenance | iCKB dApp is available on mainnet and testnet; Automata compatibility is unproven |
| [CKBoost](https://talk.nervos.org/t/dis-ckboost-gamified-community-engagement-platform-proposal/8832) | Time-bounded campaigns, approved submissions, funded reward pools, and multi-approval tips create close, payout, and recovery work | Deadline finalization and approved distribution | [Community Catalyst reported the testnet application live](https://talk.nervos.org/t/nervos-community-catalyst-quarterly-reports/8822/3); human proof approval must remain outside generic execution |
| [Stable++](https://stablepp.gitbook.io/stable++/) | Undercollateralized vaults require prompt, permissionless liquidation once a valid price and collateral condition is available | Condition-triggered risk action | [Nervos Foundation reported an October 2024 mainnet launch](https://www.nervos.org/assets/pdfs/2024_Nervos_Foundation_Year-end_Report.pdf), but no Automata integration or compatible on-chain trigger proof has been verified |
| [LiquidLane](https://talk.nervos.org/t/liquidlane-lp-backed-fiber-channel-liquidity/10686) | Lease expiry requires routing shutdown, pending-payment settlement, channel close or rebalance, recovery-lock settlement, and a vault sweep | Cross-layer operational settlement | Testnet prototype only; its September 2026 Spark proposal was rejected over custody and recovery concerns |

These examples are evidence that the problem repeats, not evidence that every project can adopt the
same contract unchanged. Each integration still needs maintainer agreement, a compatible
authorization path, and application-specific security review.

These products should own their business rules. They should not each have to invent an execution
network.

### Automation families

An automation family describes the operational lifecycle being shared. It is distinct from the
trigger evidence and from the application-specific action policy.

| Family | Typical trigger | Executor work | Candidate examples | Release posture |
|---|---|---|---|---|
| Deadline finalization | Block, epoch, or timestamp lower bound plus live state | Finalize, release, refund, or close | CKB Kickstarter, CKBoost | **V1** |
| Recurring distribution | Repeating epoch or block interval | Pay bounded recipients and create one successor job | CCC Schedule Send, grants, payroll, allowances | **V1** |
| Multi-stage maturity | Prior transaction confirmation plus later maturity | Continue a deposit, withdrawal, vesting, or claim state machine | NervDAO, iCKB | Pilot after policy review |
| State transition and batching | Presence of compatible instruction or state cells | Batch, transform, compact, or advance state | .bit / DAS | **V1**, with narrow predicates |
| Human-gated continuation | Approved proof, vote, or multisig result already committed on-chain | Execute an already-authorized settlement; never make the human decision | PactAgent, CKBoost tips and rewards | V1 only when approval is objectively verifiable |
| Condition-triggered risk action | Oracle or referenced state crosses a threshold | Liquidate, repay, top up, or rebalance within strict limits | Stable++ | Later; oracle and value-at-risk review required |
| Cross-layer operational settlement | Verifiable external or Fiber state plus CKB settlement conditions | Close, recover, sweep, or reconcile | LiquidLane | Later; credentials and custody boundary unresolved |
| Maintenance and cleanup | Expired or superseded live state | Cancel orders, reclaim capacity, settle batches, or compact state | iCKB limit orders and future marketplaces | After economics and anti-spam design |

The first release should prove at least two families with the same Job Cell lifecycle: deadline
finalization and recurring distribution. The other families extend the adapter and policy set only
after their evidence and trust boundaries are specified.

## Who Gets Value

| User | Current burden | Automata outcome |
|---|---|---|
| CKB application team | Runs a bespoke polling bot and hot key | Publishes a constrained job and outsources execution |
| DAO or grant program | Manually releases recurring payments | Funds an auditable schedule enforced by scripts |
| Protocol operator | Keeps a private maintenance service online | Competes multiple executors for the same valid action |
| End user | Must return later to finalize, refund, or claim | The action completes when its on-chain conditions are met |
| Executor operator | Has no standard market for useful CKB work | Earns a deterministic fee for successful execution |

The first buyer is the **application team**. End users benefit, but they should not be the initial
sales motion.

## Product Definition

CKB Automata consists of five parts.

### 1. Job protocol

A versioned Molecule schema defines a job's identity, trigger, action policy, reward, scheduling
metadata, and recurrence rules. The schema is small enough for wallets, indexers, and applications
to implement without adopting a hosted service.

### 2. On-chain scripts

The Job Cell scripts enforce:

- when the job may be consumed;
- which action policy is authoritative;
- which outputs the action may create;
- the maximum or exact executor reward;
- one-time execution or valid successor creation;
- sequence and replay rules; and
- cancellation and policy-verifiable expiry behavior.

Application-specific scripts still validate the underlying application transition. Automata must
not become a universal script with authority over arbitrary assets.

CKB `since` provides a not-before condition, not a transaction expiry. A `not_after` value is only
on-chain enforceable when the action policy supplies a freshness or upper-bound proof. Otherwise it
is scheduler metadata and must not be presented as a consensus guarantee.

### 3. Executor

An open-source daemon discovers jobs, tests eligibility, builds transactions through the relevant
adapter, dry-runs them, broadcasts them, retries safely, and records the outcome. Anyone can run
one. A policy may restrict a timing-sensitive transition to a user-approved executor set when late
execution would be harmful but cannot be rejected on-chain. Applications may also run their own
executor as a fallback.

### 4. SDK and adapters

The SDK lets an application:

- create and fund a job;
- define or select an action policy;
- inspect job status and execution receipts;
- cancel a cancellable job;
- estimate occupied capacity and execution reward; and
- implement an adapter that constructs the application portion of the transaction.

The reference SDK should be TypeScript first because it is the fastest route into existing CKB
frontends and CCC-based applications. Contract crates and the executor remain Rust.

### 5. Observability surface

A minimal public console shows live, eligible, completed, failed, expired, and cancelled jobs. It
is an inspection and debugging surface, not the product moat. The chain remains the source of
truth.

## How It Works

```text
Application creates Job Cell
          |
          v
Indexers expose the live job to executors
          |
          v
Trigger becomes eligible
          |
          v
Executor builds and dry-runs the transaction
          |
          v
CKB validates trigger + app action + executor proof
          |
          v
Action, executor reward, and optional successor settle atomically
          |
          v
Receipt and failure classification become visible to the application
```

An executor never receives a general signing key. Its only authority is to propose a transaction
that already satisfies the Job Cell and application scripts.

## CKB-Native Design

Automata is useful on CKB because the cell model gives each job an explicit object, budget, state,
and validation boundary.

### Integration precondition

Automata can only execute a transition that the application's scripts already authorize without
an owner's ordinary signature. It cannot autonomously move a cell protected only by a user's
standard secp256k1 lock. An integrating application must place the relevant state or funds under a
lock/type policy that permits the narrowly defined transition when its conditions are satisfied.

This is a hard product constraint. If most prospective partners need automation for
signature-gated cells they cannot redesign, Automata becomes an alerting service rather than a
non-custodial executor and should not receive a protocol-sized grant.

### Atomic settlement

A single transaction can consume the job and application state, create the intended next state,
pay the executor, and create a recurring successor. Either every part passes or none of it does.

### Permissionless transaction construction

The party constructing a transaction does not need authority over the assets when lock and type
scripts fully constrain the valid transition. This allows competition among executors without
giving them custody.

### Native time constraints

For a deadline job, the relevant `CellInput.since` value prevents inclusion before the allowed
block, epoch, or timestamp. The Job Cell script must inspect and constrain that `since` value.
A deadline may be committed in cell data, but that data does not act as a clock. Eligibility comes
from the consensus-enforced `since` constraint, and the script still does not wake itself up.

### Explicit recurring state

A recurring job consumes sequence `n` and creates exactly one valid successor at sequence `n + 1`.
The successor carries the remaining budget and an updated eligibility condition. Its script checks
continuity rather than trusting the executor.

### Capacity is part of the economics

Every Job Cell occupies CKB capacity, and a recurring successor must retain enough capacity for its
data and scripts. The SDK must quote occupied capacity separately from spendable action budget and
executor rewards. For V1, the executor should pay the network fee from its own input and receive a
fixed job reward that compensates it; silently subtracting an unconstrained fee from job value
would make value-conservation rules ambiguous.

The underlying model is described in the
[CKB RFC](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0002-ckb/0002-ckb.md)
and the
[transaction structure RFC](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0022-transaction-structure/0022-transaction-structure.md).

## Draft Job Model

The exact binary schema belongs in a later RFC. The first implementation needs the following
logical fields:

| Field | Purpose |
|---|---|
| `version` | Supports compatible decoding and migration |
| `job_id` | Stable unique identifier |
| `sequence` | Prevents replay and orders recurring executions |
| `trigger_kind` | Selects a supported trigger module |
| `trigger_params` | Deadline or state predicate parameters |
| `policy` | Identifies the on-chain policy script governing the action |
| `payload_hash` | Commits to immutable application-specific intent |
| `reward` | Amount paid after a valid execution |
| `budget` | Remaining execution and action budget |
| `not_after` | Optional scheduling deadline; enforceable only with policy proof |
| `recurrence` | One-shot or constrained successor rules |
| `cancel_authority` | Optional lock hash allowed to cancel before execution |

The first release should use a narrow, auditable set of trigger and policy modules. A supposedly
generic job language would expand the attack surface before there is evidence anyone needs it.

## Transaction Contract

A typical execution transaction contains:

```text
Inputs
  - current Job Cell
  - application state or funding cells required by the action

Cell deps
  - Automata Job Lock
  - application action-policy script
  - referenced libraries and data cells

Witnesses
  - application-specific proof or parameters
  - executor public key and signature over the committed execution

Outputs
  - valid next application state and/or recipient payment
  - executor reward locked to the signing executor
  - optional successor Job Cell
  - executor change after paying the network fee
```

The executor signature is not a source of application authority. It binds the reward address to
the submitted transaction so a mempool observer cannot copy the transaction, redirect the reward,
and steal the work. Re-broadcasting the unchanged transaction is harmless because the original
executor is still paid.

The scripts must enforce at least these invariants:

1. A one-shot job can produce no successor and cannot execute twice.
2. A recurring job produces exactly one successor with the same identity and incremented sequence.
3. The action policy and immutable payload cannot be replaced during execution.
4. The reward cannot exceed the amount committed by the job.
5. The reward output belongs to the executor identity that signed the execution commitment.
6. All value not consumed by the action or reward is preserved in required outputs.
7. Cancellation cannot masquerade as successful execution or earn a reward.

## Trigger Classes

| Trigger | Mechanism | Release |
|---|---|---|
| Block, epoch, or time not-before condition | Consensus `since` constraint on the Job Cell input | **V1** |
| Presence or consumption of matching CKB state | Required input or live dependency plus script predicate | **V1, narrow predicates** |
| Signed oracle condition | Attestation verified in witness or referenced oracle cell | Later, after trust-policy design |
| Off-chain API event | Scoped attestor signature | Later, explicitly trusted |
| Fiber event | Adapter based on supported Fiber state and security model | Later, not core V1 |
| Upper-bound time expiry | No native inverse of `since`; requires freshness proof | Policy-specific, not core V1 |

An off-chain observation is not magically trustless. V1 should support only conditions CKB can
verify directly. An executor may query arbitrary state to decide what to build, but an on-chain
script can only trust transaction inputs, outputs, dependencies, headers, witnesses, and valid
cryptographic proofs available during verification. An indexer result alone is not a trigger proof.

## Action Classes

Automata standardizes execution, not application logic. Each action class needs a constrained
policy and transaction builder. An automation family may use several actions, and the same action
may be used by more than one family.

| Priority | Action | Reusable outcome | Example evidence |
|---:|---|---|---|
| 1 | Expire, release, or refund an escrow/campaign | Applications no longer run deadline bots | CKB Kickstarter, PactAgent, CKBoost |
| 2 | Recurring CKB or token distribution | DAOs and apps can automate grants, payroll, or rewards | CCC Schedule Send, CKBoost |
| 3 | Batch or continue a deterministic state transition | Applications share discovery, retry, contention, and reward handling | .bit / DAS, iCKB |
| 4 | Finalize an auction or expire an order | Sellers and makers do not depend on one marketplace backend | iCKB limit orders; marketplace partner still required |
| 5 | Maintain collateral or liquidate an unsafe position | Lending protocols can buy liveness from competing executors | Stable++ compatibility still unverified |
| 6 | Perform protocol or cross-layer upkeep | Applications outsource periodic recovery, compaction, or settlement | LiquidLane is prototype evidence only |

V1 should implement priorities 1 and 2. Liquidation and oracle-driven jobs belong later because
they introduce pricing, contention, and value-at-risk concerns.

## Reference Workflow: Campaign Finalization

This workflow demonstrates the shared primitive without pretending Automata replaces a
crowdfunding contract.

1. A campaign creates a Job Cell containing its deadline, campaign identifier, action-policy hash,
   and executor reward.
2. After the deadline, any executor loads the campaign cells and determines whether the funding
   threshold was reached.
3. The adapter constructs either the creator-release transaction or the refund-state transaction.
4. The campaign scripts validate the business rule. The Automata script validates timing, reward,
   identity, and consumption of the job.
5. The executor receives its reward only in the successful transaction.

CKB Kickstarter already demonstrates that permissionless finalization can be encoded for one
application. Automata's contribution is reusable discovery, incentives, execution, retries,
receipts, and operational reliability across applications.

## Reference Workflow: Recurring Distribution

1. A DAO funds a Job Cell with a fixed recipient policy, interval, maximum payment, reward, and
   number of remaining periods.
2. At each interval, an executor constructs the distribution transaction.
3. The scripts pay the permitted recipients, pay the executor, and create one successor with a
   reduced budget, incremented sequence, and next deadline.
4. When the period count or budget reaches zero, no successor is permitted.

This is not arbitrary wallet automation. Recipients and limits are committed by the policy before
funding, and the executor cannot change them.

## What V1 Includes

- Versioned Job Cell schema and specification.
- Audited one-shot and recurring job scripts.
- Deadline trigger and one narrow cell-state predicate.
- CKB-denominated executor rewards.
- TypeScript SDK for job creation, cancellation, inspection, and adapter integration.
- Rust executor with discovery, dry-run, broadcast, retry, and confirmation handling.
- Reference campaign-finalization and recurring-distribution adapters.
- Minimal index/API and inspection console built on existing CKB indexing infrastructure.
- Public testnet deployment, transaction evidence, threat model, and operator runbook.

## What V1 Explicitly Excludes

- Custody of user or application private keys.
- Arbitrary transactions submitted from a user's wallet.
- A general-purpose oracle network.
- AI deciding whether or how funds move.
- Cross-chain automation.
- Fiber channel or node management.
- Liquidations using external prices.
- A token, governance system, or executor staking scheme.
- Mainnet reliability claims before an external security review.

Removing these features is part of the security design, not a lack of ambition.

## Architecture

```text
automata/
  contracts/
    job-lock/                 trigger, reward, cancellation, recurrence
    policies/
      deadline-action/        constrained one-shot reference policy
      recurring-distribution/ constrained recurring reference policy
  schemas/                    versioned Molecule definitions
  packages/
    sdk/                      TypeScript integration API
    adapter-kit/              transaction-builder interface and fixtures
  services/
    executor/                 Rust worker and retry state machine
    api/                      job discovery and execution receipts
  apps/
    console/                  inspection and debugging UI
  examples/
    campaign/
    recurring-distribution/
  docs/
    specification.md
    threat-model.md
    operator-runbook.md
```

The executor may use the built-in CKB indexer or integrate with Cellora. Building a new general
indexer is not part of the project.

## Executor State Machine

```text
DISCOVERED -> INELIGIBLE -> READY -> SIMULATED -> SUBMITTED -> CONFIRMED
                                |          |            |
                                v          v            v
                             INVALID     RETRYABLE    REORGED
                                                       |
                                                       v
                                                      READY
```

Every transition must produce a machine-readable reason. "Failed" alone is not operationally
useful. At minimum, classify jobs as not-yet-eligible, already consumed, insufficient budget,
policy mismatch, invalid application state, simulation failure, rejected transaction, conflicted
input, expired, cancelled, or reorged.

## Security Model

| Risk | Required control | Residual concern |
|---|---|---|
| Executor steals application funds | Application policy validates every permitted output; no general key | A faulty policy remains dangerous |
| Reward is copied from the mempool | Executor signs a commitment binding its reward lock | Transaction propagation still affects who executes first |
| Duplicate execution | Unique live Job Cell and sequence continuity | Competing transactions create normal input contention |
| Replay after recurrence | Stable job identity plus strictly increasing sequence | Upgrade and migration rules need review |
| Executor submits an early job | Consensus `since` plus script validation | Incorrect time encoding can lock a job longer than intended |
| Executor submits a harmful windowed job late | Restrict sensitive transition or require freshness/bond proof | Approved executor may still grief timing |
| Invalid successor drains budget | Script checks policy, value conservation, reward, and sequence | Capacity accounting must be exhaustively tested |
| One executor goes offline | Permissionless discovery and multiple operators | A reward that is too low may attract nobody |
| Reorg or dropped transaction | Confirmation tracking and idempotent retry | Applications must define acceptable confirmation depth |
| Malicious or stale oracle | No oracle trigger in V1 | Later oracle modules require explicit trust disclosure |
| Cancellation races execution | Deterministic transaction rules and visible terminal state | Both transactions may compete until one confirms |
| Denial-of-service jobs | Executors simulate locally and choose which jobs to serve | Public discovery can still contain low-quality jobs |
| Script upgrade breaks jobs | Versioned scripts and immutable code references per job | Long-lived jobs need migration and deprecation policy |

The threat model must cover script-level value conservation, transaction malleability assumptions,
capacity edge cases, witness parsing, dependency substitution, denial of service, reorg recovery,
and executor competition before mainnet use.

## Existing Work and Collision Boundary

Automata should reuse adjacent work and state its novelty narrowly.

| Existing project | What it already does | Boundary of Automata |
|---|---|---|
| [Open Transaction Pool](https://github.com/EthanYuan/open-transaction-pool) | Composes and streams partial transactions through plugin agents | Automata defines funded conditional jobs, eligibility, execution rewards, retries, and receipts |
| [OTX transaction-streaming prototype](https://talk.nervos.org/t/exploring-the-ckb-otx-paradigm-accomplishments-and-insights-from-building-a-transaction-streaming-prototype/7346) | Explores off-chain transaction collaboration and aggregation | OTX may become a transport/composition layer; it is not itself the job lifecycle |
| [CellKit Actions](https://talk.nervos.org/t/spark-program-cellkit-actions-reusable-transaction-actions-for-ckb-apps/10375) | Packages reusable transaction actions | An Action could be an Automata adapter; Automata adds triggers, funding, executors, and reliability |
| [Cellora](https://github.com/Nervos-Community-Catalyst/CKBuilder-projects) | Indexes and queries CKB data | Automata should consume it where useful, not duplicate it |
| [CKB Kickstarter](https://talk.nervos.org/t/introducing-ckb-kickstarter-decentralized-all-or-nothing-crowdfunding-on-nervos-ckb-testnet-mvp-live/10130) | Runs a testnet bot for permissionless campaign finalization, release, and refund | Strong reference integration candidate; reported testnet status is not a mainnet or audit claim |
| [PactAgent](https://talk.nervos.org/t/pactagent-from-application-to-infrastructure/10352) | Operates agreement-specific workers for deadlines, settlement, retries, and replay | Candidate for extracting a reusable job while keeping human proof and dispute decisions in PactAgent |
| [.bit / DAS Keeper](https://talk.nervos.org/t/das-ckb-keeper/5700) | Documents permissionless instruction-cell processing, batching, retries, and keeper fees | Direct architectural precedent; the 2021 design is not a current integration commitment |
| [CCC Schedule Send](https://github.com/ckb-devrel/ccc-schedule-send) | Implements scheduled token distribution in a dedicated signed backend | Reference for recurring jobs; Automata replaces broad server signing with constrained policy authority |
| [iCKB](https://github.com/ickb/whitepaper) | Manages pooled DAO deposits, receipts, maturities, withdrawals, and limit orders | Candidate multi-stage and cleanup adapters; existing protocol behavior must not be duplicated or weakened |
| [CKBoost](https://talk.nervos.org/t/dis-ckboost-gamified-community-engagement-platform-proposal/8832) | Manages time-bounded campaigns, funded rewards, approvals, and tipping payouts | Candidate for approved payout and campaign-close jobs; Automata must not approve human-submitted proof |
| [Stable++](https://stablepp.gitbook.io/stable++/) | Exposes collateral vault and liquidation workflows | Later condition-triggered candidate; oracle proof and current contract compatibility are unverified |
| [LiquidLane](https://talk.nervos.org/t/liquidlane-lp-backed-fiber-channel-liquidity/10686) | Prototypes lease expiry, channel recovery, and vault reconciliation | Research evidence only; rejected grant review identified unresolved custody and recovery risks |
| [CKB Action Links](https://talk.nervos.org/t/ckb-action-links-a-draft-protocol-for-shareable-ckb-transaction-urls/10315) | Makes transaction intents shareable and actionable | A possible job-creation surface; not a required dependency |
| [Orbital](https://talk.nervos.org/t/a-new-development-experience-for-ckb/10663) | Improves local CKB build, test, fund, and deploy workflows | Useful for development; unrelated to production execution |

The [Gone in 60ms submission roundup](https://talk.nervos.org/t/gone-in-60ms-fiber-infrastructure-hackathon-roundup/10561)
and [announced results](https://talk.nervos.org/t/gone-in-60ms-fiber-network-infrastructure-hackathon-results/10671)
contain SDKs, gateways, node tools, wallets, payment flows, watchtowers, and other Fiber
infrastructure. None found in that published set presents the same CKB L1 Job Cell plus
permissionless executor market described here.

That is a bounded research conclusion, not a claim that nobody has ever attempted scheduling on
CKB. Before a proposal is submitted, maintainers should specifically review the design for overlap
with OTX, CoBuild, CCC, CellKit Actions, and any unpublished keeper work.

## Fiber Relationship

Fiber is **not required** for the core product. Making it a dependency would weaken the initial
case because the recurring problem exists directly on CKB L1.

Later, a Fiber adapter may be justified for narrowly defined operations that can be authorized and
verified safely. It should only be added after Fiber maintainers validate the security model. CKB
Automata must not claim it can manage arbitrary channels without node credentials or protocol
support.

## Adoption Strategy

### Start with integrations, not a marketplace

There is no executor market until applications publish valuable jobs. The first work is therefore
integration-led:

1. Interview teams already operating deadline or maintenance bots.
2. Convert two real workflows into job policies with those teams.
3. Run the application's own executor plus one independent executor.
4. Measure failures, latency, reward economics, and operational work over 30 days.
5. Publish adapters and results before recruiting more operators.

### Required design partners

Secure at least three independent partners from different action classes:

- one deadline/finalization application;
- one recurring distribution or DAO workflow; and
- one state-maintenance application.

Projects controlled by the Automata builder are useful test fixtures but do not count as external
adoption.

### Integration promise

The SDK must make the application boundary small. A credible target is:

- one policy script or existing script integration;
- one deterministic transaction-builder adapter;
- one job-creation call; and
- one status query or webhook.

If every integration requires a custom executor fork, the protocol has failed to generalize.

## Economics

### Executor market

Each job carries a fixed or capped reward. Executors decide whether the reward covers indexing,
simulation, transaction fees, capital opportunity cost, and operational risk. The chain pays only
for a valid execution.

V1 should avoid auctions, staking, slashing, and protocol tokens. A simple posted reward is enough
to learn whether supply and demand exist.

### Sustainable business

The open protocol can support paid services without enclosing it:

- hosted executor with response-time and redundancy commitments;
- private or geographically redundant executor deployment;
- integration and policy-audit support;
- operational monitoring and incident history; and
- high-availability API and webhook delivery.

The durable business is reliability for applications. The public-good grant should fund the open
standard, reference scripts, SDK, executor, security work, and integrations, not an indefinite
hosted-service subsidy.

## Validation Before a DAO Proposal

Complete this phase before requesting substantial Community Fund funding.

### Two-week validation sprint

1. Interview at least five CKB application teams that currently use or expect to need an off-chain
   bot.
2. Record the exact action, current operator, key or custody model, execution frequency, failure
   cost, and monthly maintenance burden for each team.
3. Obtain three written commitments to integrate if the prototype meets stated requirements.
4. Write the draft Job Cell schema and threat model.
5. Implement one deadline job and one recurring successor on testnet.
6. Run two competing executors and demonstrate that only one transaction consumes the job while
   the correct executor reward remains protected.

### Evidence gate

Proceed to a Community Fund proposal only if all of these are true:

- three independent teams commit to integrations;
- at least two teams currently operate a bot or perform the action manually;
- the same core Job Cell lifecycle fits at least two action classes;
- the prototype executes without a general user or application key;
- executor reward theft and duplicate execution tests pass; and
- maintainers find no existing CKB project that already owns the proposed layer.

### Kill conditions

Stop or narrow the project if:

- teams prefer their existing cron service and will not integrate a shared protocol;
- no team will fund an executor reward or hosted reliability;
- each application requires materially different job semantics;
- useful actions require custody of broad signing authority;
- occupied capacity makes realistic recurring jobs uneconomic;
- OTX, CoBuild, or another maintained project already provides the same lifecycle; or
- the only integrations are projects owned by the same builder.

These are real termination criteria. The grant should not fund a platform in search of users.

## Grant Path

The recommended path follows the ecosystem's stated prototype-to-production progression:

### Stage 0: self-funded or Spark-sized validation

Deliver the validation sprint, two testnet workflows, threat-model draft, and partner commitments.
This stage proves that the problem and common abstraction exist.

### Stage 1: Community Fund production grant

Request funding only for the public infrastructure and named integrations:

- protocol specification and Molecule schemas;
- Job Cell scripts and reference policies;
- SDK, executor, and adapter kit;
- three independent application integrations;
- public testnet operation and observability;
- external security review and remediation;
- documentation, reproducible deployment, and maintenance period.

The [Community Fund DAO rules and process](https://talk.nervos.org/t/ckb-community-fund-dao-rules-and-process/6874)
should govern the actual proposal. The
[Spark Q1 2026 review](https://talk.nervos.org/t/spark-program-q1-2026-what-builders-are-telling-us/10114)
supports using small grants for prototypes and demand validation before asking the DAO to fund
scale-up.

Do not choose a dollar amount until design partners fix the integration scope and the security
review is quoted. Budget uncertainty should be removed before the vote, not hidden inside a large
contingency.

## Proposed Milestones

### M0: Demand and feasibility, 2 weeks, pre-grant

Deliverables:

- five structured builder interviews;
- three signed integration commitments;
- draft schema and threat model;
- one-shot deadline prototype;
- recurring successor prototype; and
- public testnet transaction evidence.

Pass condition: every evidence-gate item above is satisfied.

### M1: Protocol and scripts, 4 weeks

Deliverables:

- versioned specification;
- Molecule schemas;
- Job Lock and recurrence logic;
- deadline and cell-state trigger modules;
- campaign and recurring-distribution policies; and
- unit, property, and adversarial tests.

Pass condition: published test vectors independently reproduce valid and invalid transitions.

### M2: SDK and executor, 4 weeks

Deliverables:

- TypeScript SDK and adapter interface;
- Rust executor;
- dry-run, retry, reorg, and confirmation handling;
- machine-readable failure classifications;
- CLI and operator runbook; and
- reproducible deployment.

Pass condition: two independent executors can process the same job stream without duplicate state
transitions or reward redirection.

### M3: External integrations, 5 weeks

Deliverables:

- three independent application integrations;
- application-owned fallback executor instructions;
- inspection console and public metrics;
- integration postmortems; and
- at least 30 days of testnet operation.

Pass condition: all three partners execute their real workflow from their own codebase, rather than
a demonstration repository controlled by the Automata team.

### M4: Security and release, 4 weeks

Deliverables:

- independent review of scripts and executor assumptions;
- fixes and regression tests;
- versioning, migration, and deprecation policy;
- tagged releases with reproducible hashes;
- incident-response process; and
- defined maintenance term and response expectations.

Pass condition: all critical and high-severity findings are resolved and publicly documented
before any mainnet recommendation.

## Grant Acceptance Metrics

A grant should be considered complete only when the evidence is public and reproducible:

| Metric | Acceptance threshold |
|---|---|
| External adoption | Three independent applications merged and running integrations |
| Workflow breadth | At least two distinct action classes use the same job lifecycle |
| Sustained operation | Thirty consecutive testnet days with public status history |
| Execution evidence | At least 1,000 successful test executions, including real partner jobs and controlled load tests |
| Contention safety | No duplicate state transition under concurrent executor tests |
| Reward safety | No successful reward redirection in published adversarial tests |
| Recovery | Dropped, conflicted, and reorged transactions return to a valid terminal or retry state |
| Transparency | Transaction hashes, latency, executor, policy version, and failure class are queryable |
| Reproducibility | A third party can deploy an executor and reproduce test vectors from documentation |
| Security | No unresolved critical or high-severity review finding at release |

The report must separate real partner executions from synthetic load. A large test counter by
itself does not prove demand.

## Why This Team Could Be Credible

The builder already has relevant CKB work in transaction construction, testing, observability, and
Fiber infrastructure through projects such as Fiber Forge, CKB Action Links, ckb-viz, and Infern.
That background reduces protocol-learning risk.

It does not prove demand. The proposal becomes credible when external teams commit their own
applications and workflows to the protocol.

## The Honest Pitch

> CKB applications can enforce what a valid state transition looks like, but they still need an
> off-chain actor to notice when it is time, construct the transaction, submit it, and recover from
> failure. Teams currently solve that liveness problem independently. CKB Automata introduces a
> standard funded Job Cell, constrained action policies, and an open executor so any operator can
> perform a valid action and earn its reward without custody of application keys. The grant would
> fund the open protocol, audited reference scripts, SDK, executor, and three external integrations.
> It would not fund demand discovery: those integrations must be committed before the proposal.

## Final Recommendation

CKB Automata is a serious infrastructure idea if it proves one claim: **multiple independent CKB
applications will replace their bespoke automation with the same job lifecycle**.

That claim is more important than the dashboard, executor count, or feature list. Validate it first.
If three external teams commit and the non-custodial prototype survives adversarial testing, take
the production build to the Community Fund DAO. If they do not, do not romanticize the protocol;
stop.
