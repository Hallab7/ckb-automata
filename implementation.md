# CKB Automata Showcase POC Implementation Plan

> A working, non-custodial CKB testnet product demonstration that a nontechnical user can operate.

**Document type:** Full implementation plan  
**Planning snapshot:** 21 September 2026  
**Target:** Public testnet showcase; not a mainnet or audited release  
**Package manager:** pnpm  
**Frontend:** Next.js App Router, React, TypeScript, CCC  
**Backend:** NestJS, PostgreSQL, Redis, BullMQ  
**Contracts:** Rust CKB scripts with Molecule schemas, `ckb-std`, and `ckb-testtool`  
**Canonical product specification:** [CKB_AUTOMATA_FULL_PROJECT_DOCUMENTATION.md](./CKB_AUTOMATA_FULL_PROJECT_DOCUMENTATION.md)

---

## 1. Implementation Outcome

This plan delivers a working product demonstration rather than a code-only proof. A person who does
not understand CKB cells, scripts, witnesses, or epochs must be able to:

1. open the application and understand what it does;
2. connect a supported wallet through CCC;
3. choose a deadline or recurring-payment automation;
4. enter plain-language parameters;
5. review the exact authority, amount, reward, timing, and recovery path;
6. sign one job-creation transaction locally;
7. watch an independent executor perform the eligible action on CKB testnet;
8. inspect the confirmed transaction and successor job; and
9. cancel or recover remaining funds with the owner wallet.

The showcase must prove two automation families with the same Job Cell lifecycle:

- **Deadline finalization:** a test campaign reaches its block deadline and deterministically
  releases or refunds its committed funds.
- **Recurring distribution:** a funded job pays a fixed recipient at a fixed block interval and
  creates exactly one successor until the run count is exhausted.

NervDAO Cycle Guard may be presented as a clearly labeled research preview. Automated DAO harvest
must not be represented as implemented until its separate vault, maturity, and security work exists.

## 2. Definition of Done

The showcase is complete only when all of the following are true:

- Both reference workflows execute end to end on CKB testnet.
- The browser wallet signs creation, cancellation, and recovery transactions; the server never
  receives a user private key or unrestricted signature.
- The executor owns only its low-value fee inputs and receives only the reward committed by the job.
- Contract tests prove value conservation, immutable recipient/policy fields, reward binding,
  sequence increments, and exactly-one-successor behavior.
- The API can rebuild its indexed view from CKB without depending on its previous database contents.
- A reorg, dropped transaction, conflicting executor, or backend restart does not create a false
  confirmed state or duplicate valid transition.
- A first-time user can complete the primary guided flow without developer assistance.
- Every transaction state is labeled accurately as draft, awaiting signature, submitted, proposed,
  committed, confirmed, conflicted, dropped, cancelled, or recovery-required.
- Demo mode is visibly separate from live testnet mode.
- The deployment, reset procedure, presenter guide, operator runbook, and recovery guide are tested.
- No critical or high-severity finding remains in the showcase threat review.

## 3. Scope Boundary

### 3.1 Included

- Next.js application with responsive desktop and mobile layouts.
- CCC wallet connection and local transaction signing.
- NestJS read/transaction-construction API.
- NestJS standalone executor worker.
- PostgreSQL indexed read model and event history.
- Redis-backed BullMQ work queues.
- Job Lock, deadline policy, recurring-distribution policy, and small demo campaign scripts.
- Shared Molecule-generated codecs and TypeScript SDK.
- Live CKB testnet mode and seeded presentation mode.
- Cancellation, recovery, receipts, notifications, observability, and operator controls.
- Local, CI, preview, and public testnet deployment paths.

### 3.2 Excluded

- Mainnet deployment or claims of production readiness.
- Custody of user keys or arbitrary transaction scheduling.
- A protocol token, staking, slashing, fee auction, or governance system.
- Trustless HTTP/webhook triggers.
- Mainnet NervDAO harvesting or a Harvest Vault.
- xUDT payouts in the showcase; the two implemented workflows use native testnet CKB.
- Oracle-driven liquidation and Fiber credential management.
- Subjective approval of campaign evidence, disputes, or human work.
- Continuous per-second streaming payments.

## 4. Fixed Architecture Decisions

| Area | Decision | Reason |
|---|---|---|
| Source layout | One pnpm monorepo for the showcase | Keeps shared schemas, SDK, UI, and application versions synchronized while retaining deployable boundaries |
| Frontend | Next.js App Router with TypeScript | Current supported Next.js application model with route-level loading/error states |
| Wallet | `@ckb-ccc/connector-react` | Recommended CCC integration for React and Next.js applications |
| Browser chain client | CCC testnet client behind a client-only provider | CCC uses browser APIs and React context; wallet code must not execute as a Server Component |
| Backend | NestJS REST API with generated OpenAPI | Clear module boundaries, validation, health checks, and client generation |
| Node CKB client | `@ckb-ccc/shell` | CCC package intended for Node.js without browser wallet dependencies |
| Database | PostgreSQL with Drizzle ORM and SQL migrations | Typed relational read model with explicit, reviewable migrations |
| Durable work | Redis and BullMQ through `@nestjs/bullmq` | Persists work across process restarts and separates API from workers |
| Chain scheduling | Block/epoch eligibility derived from CKB | Server wall-clock and cron are wake-up hints, never trigger proof |
| Contracts | Rust `no_std` scripts using `ckb-std` | Native CKB script implementation path |
| Contract tests | `ckb-testtool` plus generated fixtures | Deterministic script and transaction verification |
| Schema | Molecule as the canonical binary schema | Shared on-chain encoding with generated Rust and TypeScript bindings |
| Styling | Tailwind CSS, Radix primitives, Lucide icons, local design tokens | Accessible components without imposing a decorative visual system |
| Client data | TanStack Query plus typed OpenAPI client | Explicit server-state caching, invalidation, and retry policy |
| Forms | React Hook Form and Zod | Accessible, typed, step-based validation |
| Testing | Vitest, Testing Library, Playwright, Nest test utilities, `ckb-testtool` | Unit, integration, contract, and browser coverage |
| Observability | OpenTelemetry, structured logs, Prometheus metrics, error tracking | Trace job discovery through confirmation without making telemetry authoritative |

Exact versions must be pinned in the lockfiles during Phase 02. The versions observed while this
plan was written were Next.js `16.3.5`, React `19.3.0`, NestJS `12.0.4`, CCC React connector
`2.1.6`, CCC shell `1.3.13`, BullMQ `6.3.8`, TypeScript `7.0.2`, and pnpm `12.5.1`. These are a
research snapshot, not floating ranges. Phase 02 must confirm their compatibility before adoption.

## 5. Runtime Architecture

```text
+----------------------------- Browser ------------------------------+
| Next.js UI                                                        |
| CCC wallet -> local review/signing -> direct or API-assisted send |
+---------------------+----------------------+------------------------+
                      | REST/SSE             | CKB RPC reads
                      v                      v
+---------------------+-----+      +---------+------------------------+
| NestJS API                |      | CKB testnet node + indexer       |
| quotes, unsigned txs,     |<---->| canonical cells and tx status   |
| read model, auth, events  |      +----------------+-----------------+
+------------+--------------+                       ^
             |                                      |
       +-----v------+        +----------------------+-----------------+
       | PostgreSQL |        | NestJS executor worker                |
       | read model |        | discover -> build -> dry-run -> send  |
       +------------+        +----------------------+-----------------+
             ^                                      |
       +-----+------+                               |
       | Redis /   |<------------------------------+
       | BullMQ    |  durable eligibility, submit, confirm, notify
       +------------+
```

### 5.1 Trust boundaries

- CKB consensus and scripts are authoritative for transaction validity and settlement.
- The browser wallet is authoritative for owner approval.
- The executor is trusted for availability only, not for policy, recipient, amount, or custody.
- The API and database are convenience indexes and transaction builders, not trigger evidence.
- Redis records operational work, not protocol state.
- Demo fixtures are presentation data and must never appear as testnet confirmations.

### 5.2 Signing boundary

- The backend returns normalized quotes and unsigned transaction skeletons.
- The browser uses CCC to add the owner's required inputs, fee, and change before final review.
- The frontend independently decodes the completed unsigned transaction, verifies that its
  policy-critical fields still match the quote, and displays that exact transaction before signing.
- If any input, fee, change, quote, or chain snapshot requires rebuilding, the review step repeats.
- CCC signs only in the browser wallet context.
- The backend never accepts seed phrases, private keys, wallet export files, or raw unrestricted
  signatures.
- The executor uses a separate operator fee key stored in a deployment secret manager. Its balance
  is capped and it has no authority over user-owned cancellation or recovery paths.

## 6. Repository Layout

```text
ckb-automata/
|-- apps/
|   |-- web/                    # Next.js frontend
|   |-- api/                    # NestJS REST/read API
|   `-- executor/               # NestJS standalone BullMQ worker
|-- packages/
|   |-- core/                   # Job types, states, errors, integer helpers
|   |-- molecule/               # Generated TypeScript codecs
|   |-- ccc/                    # Browser and Node transaction builders
|   |-- adapters/               # Deadline and recurring adapters
|   |-- api-client/             # Generated OpenAPI client
|   |-- ui/                     # Shared accessible product components
|   |-- config/                 # ESLint, TypeScript, Vitest configuration
|   `-- testing/                # Fixtures, mock RPC, adversarial helpers
|-- contracts/
|   |-- schemas/                # Canonical Molecule definitions
|   |-- job-lock/               # Execute, cancel, recover authorization
|   |-- deadline-policy/        # Deadline execution constraints
|   |-- recurring-policy/       # Payout and successor constraints
|   |-- demo-campaign-type/     # Testnet showcase campaign state
|   `-- tests/                  # ckb-testtool integration and properties
|-- database/
|   |-- migrations/
|   `-- seeds/
|-- deploy/
|   |-- docker/
|   |-- kubernetes-or-platform/
|   `-- manifests/              # Network-specific code hashes and deps
|-- docs/
|   |-- protocol/
|   |-- api/
|   |-- operator/
|   |-- recovery/
|   `-- demo/
|-- scripts/
|-- pnpm-workspace.yaml
|-- Cargo.toml
|-- package.json
`-- pnpm-lock.yaml
```

## 7. Canonical Domain Model

### 7.1 Job Cell

The implementation begins from the logical schema in the full specification and finalizes it only
after occupied-capacity and CKB-VM cycle measurements:

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
  not_after: Uint64,
  remaining_runs: Uint32,
  cancel_lock_hash: Byte32,
}
```

`not_after` is scheduling metadata unless the selected policy can prove freshness on-chain. The UI
must not call an advisory upper bound an enforceable deadline.

Each live Job Cell uses the Automata Job Lock and an application policy type script. The Job Lock
must verify that `policy_script_hash` equals the actual policy type-script hash on the consumed Job
Cell. The policy script validates the application inputs, outputs, trigger evidence, and successor.
The scripts therefore fail together if a transaction removes, substitutes, or bypasses the committed
policy.

Owner cancellation, recovery, and top-up use a co-spent owner-authentication input. That input is
locked by the user's normal wallet lock and therefore validates the wallet signature in its own lock
group. The Job Lock verifies that the full lock-script hash of the co-spent input matches
`cancel_lock_hash`; it must not treat the stored hash alone as proof of authorization.

### 7.2 Required lifecycle invariants

1. One consumed Job Cell pays at most one committed reward.
2. A one-shot job creates no successor.
3. A recurring execution creates exactly one successor.
4. A successor preserves `job_id`, policy, payload commitment, owner, and recipient constraints.
5. A successor increments `sequence` by exactly one.
6. Remaining runs and remaining budget cannot increase during execution.
7. Cancellation and recovery pay no executor reward.
8. Unspent value returns to the owner or remains in the exact required successor.
9. The reward output is bound to the executor identity committed by the transaction.
10. Indexer results and API responses are never accepted as script evidence.

### 7.3 On-chain states

```text
LIVE -> EXECUTED_TERMINAL
LIVE -> LIVE_SUCCESSOR
LIVE -> CANCELLED
LIVE -> RECOVERED
```

Operational states such as discovered, building, submitted, dropped, or reorged belong to the
off-chain event model and must not be encoded as false on-chain states.

### 7.4 Executor state machine

```text
DISCOVERED -> UNSUPPORTED
DISCOVERED -> NOT_YET_ELIGIBLE -> READY
READY -> BUILDING -> SIMULATED -> SUBMITTED -> PROPOSED -> COMMITTED -> CONFIRMED

BUILDING/SIMULATED -> INVALID | RETRYABLE
SUBMITTED/PROPOSED -> DROPPED | CONFLICTED | RETRYABLE
COMMITTED -> REORGED -> READY

Terminal:
CONFIRMED | CANCELLED | EXPIRED | CONSUMED_BY_OTHER | INVALID | UNSUPPORTED
```

## 8. Reference Workflows

### 8.1 Deadline campaign

1. The user creates a small test campaign with target, deadline block, success recipient, refund
   rules, and funded executor reward.
2. The campaign and job appear as scheduled.
3. After the lower-bound deadline, any compatible executor may build a finalize transaction.
4. The demo campaign script determines success or failure from committed cells.
5. The policy permits only the corresponding release or refund state transition.
6. The executor receives the fixed reward atomically.
7. The UI shows the confirmed terminal receipt.

### 8.2 Recurring distribution

1. The user selects one recipient, fixed amount, block interval, first eligible block, number of
   runs, fixed executor reward, and maximum funded budget.
2. The wallet signs one creation transaction.
3. At each interval, an executor pays the fixed recipient and itself.
4. The same transaction creates one successor with `sequence + 1`, reduced runs, reduced budget,
   and the next lower-bound block.
5. The final run pays the recipient and executor, then returns remaining non-required capacity to
   the owner without creating a successor.

### 8.3 Research preview

The NervDAO preview is educational only. It may calculate an illustrative cycle, explain the two
withdrawal phases, and link to the full research. It must not create a vault, ask for an automation
signature, imply a fixed return, or display a simulated action as a real scheduled job.

## 9. Backend Modules

| Module | Responsibility |
|---|---|
| `ConfigModule` | Typed environment validation and deployment profile |
| `HealthModule` | Liveness, readiness, database, Redis, RPC, and index lag checks |
| `NetworkModule` | Network metadata, script deployments, tip, and confirmation policy |
| `ChainModule` | CCC Node client, RPC abstraction, dry-run, transaction status |
| `IndexerModule` | Job Cell discovery, checkpoints, reorg rollback, deterministic replay |
| `JobsModule` | Job read model, filtering, owner queries, state derivation |
| `QuotesModule` | Capacity, reward, fee, and schedule quotations |
| `TransactionsModule` | Unsigned create, cancel, recovery, and top-up builders |
| `EventsModule` | Immutable operational timeline and SSE stream |
| `ExecutorModule` | Eligibility, adapter dispatch, simulation, submission, confirmation |
| `NotificationsModule` | Signed webhooks and optional email/browser notifications |
| `AuthModule` | Wallet challenge/response for private notification settings only |
| `DemoModule` | Explicitly isolated fixture-backed presentation data |
| `AdminModule` | Protected operational pause, replay, and dead-letter inspection |
| `TelemetryModule` | Logs, traces, metrics, redaction, and correlation IDs |

The API process must not execute chain jobs inline. It publishes durable work to BullMQ; the
executor consumes that work in a separate process.

## 10. API Surface

### 10.1 Public reads

```text
GET /v1/network
GET /v1/templates
GET /v1/jobs
GET /v1/jobs/{jobId}
GET /v1/jobs/{jobId}/events
GET /v1/jobs/{jobId}/quote
GET /v1/accounts/{lockHash}/jobs
GET /v1/transactions/{txHash}
GET /v1/events/stream
```

### 10.2 Unsigned transaction construction

```text
POST /v1/transactions/create-deadline-job
POST /v1/transactions/create-recurring-job
POST /v1/transactions/cancel-job
POST /v1/transactions/recover-job
POST /v1/transactions/top-up-job
POST /v1/transactions/validate-signed
```

These endpoints return a transaction skeleton, signing entries, normalized human-readable intent,
chain snapshot, quote expiry, and a hash of policy-critical fields. They do not sign for the user.

### 10.3 Authenticated preferences

```text
POST   /v1/auth/challenge
POST   /v1/auth/verify
GET    /v1/preferences
PUT    /v1/preferences
POST   /v1/webhooks
DELETE /v1/webhooks/{webhookId}
```

Authentication proves control of an address for off-chain settings. It never authorizes an
on-chain transfer.

### 10.4 Response rules

- Monetary JSON values are decimal strings of integer shannons.
- Block numbers, epochs, hashes, scripts, and outpoints are never converted through JavaScript
  floating-point numbers.
- Every derived job response includes its source outpoint, observed block hash, block number, and
  index checkpoint.
- Cursor pagination is stable and deterministic.
- Reorged events stay visible and reference the replacement state when known.
- OpenAPI is generated in CI and the frontend client is generated from the committed specification.

## 11. PostgreSQL Read Model

| Table | Purpose |
|---|---|
| `networks` | Network identifier, genesis hash, RPC profile, confirmations |
| `script_deployments` | Code hashes, hash types, cell deps, deployment transaction |
| `indexer_checkpoints` | Last canonical block and hash processed per network |
| `canonical_blocks` | Small rollback window for reorg detection |
| `jobs` | Latest indexed Job Cell projection |
| `job_versions` | Every observed sequence/outpoint for a job identity |
| `job_events` | Append-only indexed and operational timeline |
| `transaction_attempts` | Build, dry-run, submit, proposal, commit, confirmation status |
| `executor_receipts` | Signed non-authoritative operational receipts |
| `notification_subscriptions` | Owner-scoped notification configuration |
| `webhook_deliveries` | Attempts, signatures, response codes, and retry schedule |
| `auth_challenges` | Short-lived address ownership challenges |
| `dead_letters` | Exhausted operational work requiring review |
| `demo_scenarios` | Fixture identifiers only; isolated from live tables |

The database stores no seed phrases, wallet private keys, unrestricted signed transactions, or
sensitive wallet-provider tokens.

## 12. Frontend Information Architecture

```text
/                         -> redirect to /automations
/automations              -> dashboard and filters
/automations/new          -> template selection
/automations/new/deadline -> deadline setup wizard
/automations/new/recurring-> recurring setup wizard
/automations/{jobId}      -> status, policy, timeline, funds, recovery
/activity                  -> transaction and execution history
/demo                      -> clearly labeled guided scenarios
/research/nervdao          -> non-transactional research preview
/settings                  -> network, notifications, privacy, wallet
```

### 12.1 Primary navigation

- Automations
- New automation
- Activity
- Demo
- Settings
- Wallet/network control

### 12.2 Interaction principles

- The application opens on the working dashboard, not a marketing landing page.
- Setup uses a short stepper with one decision per screen.
- CKB units are formatted for people, while review details retain exact shannons.
- Every state has a plain-language explanation and the next available action.
- Destructive owner actions require review and wallet confirmation.
- Technical details are available on demand but do not block ordinary use.
- Icons use Lucide; unfamiliar actions have tooltips and accessible names.
- Colors never carry status without text and icons.
- Mobile layouts preserve action order and never hide recovery controls.
- No nested decorative cards, oversized hero type, or promotional copy inside the product.

### 12.3 Human-readable signing summary

Before CCC opens the wallet, the review screen must show:

- what will happen;
- earliest eligible block and approximate time with uncertainty;
- recipient and amount per execution;
- number of executions;
- executor reward per execution;
- maximum network-fee estimate and who pays it;
- total capacity locked and recoverable amount;
- immutable fields;
- cancellation and recovery behavior;
- testnet badge and network identity; and
- a technical-details disclosure containing scripts, hashes, outpoints, and serialized payload.

## 13. Delivery Rules

Every numbered phase below is a separate, reviewable implementation unit. Do not merge several
phases into one large change merely because they share a workstream.

For each phase:

1. create or update the stated artifact only;
2. add focused tests with the behavior;
3. run the phase validation plus all affected package checks;
4. run formatting and `git diff --check`;
5. record fixture-backed, local-chain, and public-testnet evidence separately;
6. update generated artifacts only through their documented generator; and
7. merge or commit the phase before starting the next dependent phase.

A phase is not complete because code compiles. Its exit gate must be demonstrated.

---

## 14. Phased Implementation

### Workstream A: Product and Workspace Foundation

### Phase 00: Freeze Showcase Acceptance

**Depends on:** None  
**Implement:** Convert Section 2 into a checked acceptance document with named owners and evidence
locations. Record testnet-only and non-custodial boundaries.  
**Verify:** Product, contract, frontend, and backend owners approve the same acceptance wording.  
**Exit gate:** No requirement depends on an undefined “working demo” interpretation.

### Phase 01: Record Architecture Decisions

**Depends on:** Phase 00  
**Implement:** Add ADRs for the monorepo, Next.js/CCC client boundary, Nest API/executor separation,
PostgreSQL, Redis/BullMQ, Rust scripts, and testnet-only release.  
**Verify:** Each ADR lists alternatives, consequences, and reversal cost.  
**Exit gate:** No core technology remains an implicit decision.

### Phase 02: Pin the Toolchain

**Depends on:** Phase 01  
**Implement:** Pin Node, pnpm, Rust, RISC-V target/tooling, Docker images, and direct dependency
versions. Commit lockfiles and engine constraints.  
**Verify:** Clean Windows and Linux environments report the same versions and install successfully.  
**Exit gate:** A dependency is never resolved from an unbounded `latest` range in CI.

### Phase 03: Create the pnpm Workspace

**Depends on:** Phase 02  
**Implement:** Create the root workspace, package scripts, shared TypeScript configuration, and the
directory skeleton from Section 6.  
**Verify:** `pnpm install`, recursive typecheck placeholders, and workspace dependency resolution.  
**Exit gate:** Every TypeScript package is addressable by package name without source-path aliases.

### Phase 04: Create the Cargo Workspace

**Depends on:** Phase 02  
**Implement:** Add the root Cargo workspace and empty contract/test crates with the pinned
toolchain and RISC-V build configuration.  
**Verify:** Native test crates compile and empty script binaries build reproducibly.  
**Exit gate:** Rust builds do not depend on an undocumented local tool installation.

### Phase 05: Add Shared Quality Configuration

**Depends on:** Phases 03-04  
**Implement:** Add formatting, linting, TypeScript strictness, Rust formatting/clippy, commit checks,
and generated-file exclusions.  
**Verify:** Intentionally malformed fixtures prove every check runs and fails correctly.  
**Exit gate:** Root commands produce nonzero exits on violations.

### Phase 06: Add Continuous Integration Skeleton

**Depends on:** Phase 05  
**Implement:** Add install, lint, typecheck, unit-test, contract-build, contract-test, and artifact
jobs with deterministic caches.  
**Verify:** CI passes on the scaffold and fails when a controlled test is broken.  
**Exit gate:** Branch protection can require every foundational check.

### Phase 07: Add Local Infrastructure

**Depends on:** Phase 03  
**Implement:** Add Docker Compose for PostgreSQL and Redis, health checks, named development
volumes, and non-secret sample configuration.  
**Verify:** One command starts services and another health command confirms readiness.  
**Exit gate:** No developer must install PostgreSQL or Redis globally.

### Phase 08: Define Environment Profiles

**Depends on:** Phase 07  
**Implement:** Define `local`, `test`, `testnet-preview`, and `testnet-public` schemas with Zod
validation and explicit network identifiers.  
**Verify:** Missing, unknown, and cross-network values fail at process startup.  
**Exit gate:** A mainnet endpoint cannot be selected by an undocumented default.

### Phase 09: Establish Secret Handling

**Depends on:** Phase 08  
**Implement:** Document secret names, local placeholders, deployment secret-manager mapping,
redaction rules, rotation, and executor fee-key limits.  
**Verify:** Repository scan finds no real secret; log tests prove configured values are redacted.  
**Exit gate:** User keys are absent and operator keys cannot appear in logs or fixtures.

### Phase 10: Define the Shared Vocabulary

**Depends on:** Phase 00  
**Implement:** Add canonical terms for job, policy, trigger, action, successor, reward, cancellation,
recovery, submitted, committed, and confirmed.  
**Verify:** UI copy, API enums, and contract documentation map to the same glossary.  
**Exit gate:** No component uses “scheduled,” “executed,” or “confirmed” ambiguously.

### Workstream B: Protocol Schema and Contract Foundations

### Phase 11: Specify JobDataV1 in Molecule

**Depends on:** Phases 04 and 10  
**Implement:** Convert the logical schema into a versioned Molecule definition with comments,
integer units, enum assignments, reserved values, and canonical hashing rules.  
**Verify:** Schema review covers every lifecycle invariant and rejects DAO-specific fields.  
**Exit gate:** One canonical file defines the binary format.

### Phase 12: Generate Rust and TypeScript Codecs

**Depends on:** Phase 11  
**Implement:** Add deterministic generation scripts and commit generated Rust and TypeScript
bindings with source hashes.  
**Verify:** Regeneration produces a clean diff; cross-language fixture bytes match.  
**Exit gate:** Neither runtime contains a hand-written competing codec.

### Phase 13: Define Error Codes

**Depends on:** Phase 11  
**Implement:** Allocate stable script errors, SDK errors, API errors, and executor failure codes with
plain-language mappings.  
**Verify:** Duplicate-code and missing-copy tests.  
**Exit gate:** Every planned invalid transition has a stable diagnostic.

### Phase 14: Create Contract Fixture Builders

**Depends on:** Phase 12  
**Implement:** Build reusable `ckb-testtool` helpers for cells, headers, scripts, witnesses,
owner locks, executor identities, and capacity calculations.  
**Verify:** Golden fixtures serialize identically across repeated test runs.  
**Exit gate:** Contract tests do not duplicate transaction setup boilerplate.

### Phase 15: Implement Job Identity

**Depends on:** Phases 11-14  
**Implement:** Implement domain-separated `job_id` derivation from network, protocol version,
creation commitment, output index/Type ID, creator nonce, and policy hash.  
**Verify:** Collision, cross-network, cross-version, and changed-policy test vectors.  
**Exit gate:** The same creation on different networks or versions cannot reuse an identity.

### Phase 16: Implement Job Lock Owner Mode

**Depends on:** Phase 15  
**Implement:** Add owner-authorized cancellation/recovery dispatch; require a co-spent normal wallet
input whose full lock-script hash matches `cancel_lock_hash`. Do not add executor execution yet.  
**Verify:** Valid owner-auth input succeeds; wrong lock hash, missing co-spent input, invalid wallet
signature, and altered refund fail.  
**Exit gate:** The owner can recover a fixture job without Automata services.

### Phase 17: Implement Job Lock Execution Mode

**Depends on:** Phase 16  
**Implement:** Add the permissionless execution branch, policy-script commitment, executor identity
commitment, and reward-output binding.  
**Verify:** Changed policy, reward amount, reward recipient, mode, or identity fails.  
**Exit gate:** A copied transaction cannot redirect the reward.

### Phase 18: Enforce Value Conservation

**Depends on:** Phase 17  
**Implement:** Account for job budget, reward, application payout, occupied capacity, successor,
owner refund, and allowed fee-input separation.  
**Verify:** Property tests mutate every output capacity and attempt value leakage.  
**Exit gate:** No valid path loses job-controlled value to an uncommitted output.

### Phase 19: Enforce One-Shot Termination

**Depends on:** Phase 18  
**Implement:** Validate that a terminal execution creates no successor and routes all remaining
policy-controlled value correctly.  
**Verify:** Zero, one, and multiple successor permutations.  
**Exit gate:** One-shot jobs cannot be replayed through a forged successor.

### Phase 20: Enforce Recurring Successors

**Depends on:** Phase 18  
**Implement:** Require exactly one successor with the same identity and immutable commitments,
`sequence + 1`, reduced run count, reduced budget, and valid next trigger.  
**Verify:** Mutation matrix for every immutable and monotonic field.  
**Exit gate:** Recurrence cannot fork, reset, or increase its authority.

### Phase 21: Implement Lower-Bound Trigger Validation

**Depends on:** Phase 17  
**Implement:** Validate absolute block, epoch, and timestamp `since` encodings supported by the POC;
document unsupported relative and upper-bound semantics.  
**Verify:** Boundary tests immediately before, at, and after eligibility.  
**Exit gate:** A job cannot execute before its committed lower bound.

### Phase 22: Implement Cancellation Semantics

**Depends on:** Phases 16 and 18  
**Implement:** Define cancellation outputs, forbid executor rewards, close future recurrence, and
preserve application funds according to the policy.  
**Verify:** Cancellation racing an execution and cancellation of each supported state.  
**Exit gate:** Owner cancellation is deterministic and independently constructible.

### Phase 23: Implement Recovery Semantics

**Depends on:** Phase 22  
**Implement:** Define recovery for unsupported policy versions, invalid application state, and
terminal operational failure without weakening normal execution rules.  
**Verify:** Recovery cannot be used by a non-owner or redirect protected application outputs.  
**Exit gate:** Every funded contract state has a documented exit path.

### Phase 24: Implement Optional Top-Up Semantics

**Depends on:** Phase 20  
**Implement:** Allow owner-signed reward/budget top-up while preserving identity, sequence, policy,
payload, recipients, and run limits.  
**Verify:** Attempts to alter immutable intent during top-up fail.  
**Exit gate:** An uneconomic live job can be funded without being replaced by a different job.

### Workstream C: Reference Policies and Contract Assurance

### Phase 25: Specify the Demo Campaign State

**Depends on:** Phase 11  
**Implement:** Define minimal campaign state, pledge accounting, target, lower-bound deadline,
success recipient, refund commitment, and terminal markers.  
**Verify:** Specification review proves the outcome is objective and contains no subjective input.  
**Exit gate:** Campaign success can be determined entirely from transaction-verifiable state.

### Phase 26: Implement Demo Campaign Creation

**Depends on:** Phase 25  
**Implement:** Implement the campaign type rules for creation and pledge-state commitments needed by
the showcase.  
**Verify:** Valid creation and malformed target/deadline/capacity cases.  
**Exit gate:** A deterministic campaign fixture can be created under testtool.

### Phase 27: Implement Campaign Success Finalization

**Depends on:** Phases 21 and 26  
**Implement:** Permit release to the fixed success recipient only after the lower-bound deadline and
only when the committed target condition is met.  
**Verify:** Early, under-target, wrong-recipient, reward-redirection, and extra-output failures.  
**Exit gate:** The successful deadline flow settles action and reward atomically.

### Phase 28: Implement Campaign Failure Finalization

**Depends on:** Phases 21 and 26  
**Implement:** Permit only the committed refund-state transition after the deadline when the target
condition is not met.  
**Verify:** Incorrect refund recipient/amount/order and mixed success/refund attempts fail.  
**Exit gate:** The failed deadline flow is deterministic and permissionless.

### Phase 29: Implement the Deadline Policy Adapter Contract

**Depends on:** Phases 27-28  
**Implement:** Bind JobDataV1 payload and policy commitments to the campaign input, terminal output,
reward, and absence of a successor.  
**Verify:** Campaign and job fixtures pass together; either contract rejects cross-wired fixtures.  
**Exit gate:** The deadline action cannot be executed against a different campaign.

### Phase 30: Specify Recurring Distribution Payload

**Depends on:** Phase 11  
**Implement:** Define owner, recipient lock, amount, interval, first eligible block, run count, reward,
and final-refund behavior.  
**Verify:** Canonical hashing and cross-language vectors.  
**Exit gate:** Every mutable and immutable field is explicitly classified.

### Phase 31: Implement Recurring Payout Validation

**Depends on:** Phases 20-21 and 30  
**Implement:** Require the exact recipient output and amount for each eligible execution.  
**Verify:** Wrong recipient, amount, asset, early execution, and duplicate payout fail.  
**Exit gate:** The executor has no discretion over the payment.

### Phase 32: Implement Recurring Next-Trigger Validation

**Depends on:** Phase 31  
**Implement:** Derive the successor lower bound from the previous committed schedule rather than the
actual execution block, with a documented late-execution rule.  
**Verify:** On-time, late, skipped-interval, overflow, and zero-interval tests.  
**Exit gate:** Executor delay cannot silently rewrite the schedule.

### Phase 33: Implement Recurring Final Run

**Depends on:** Phase 32  
**Implement:** Terminate when the committed run count reaches zero and return allowed residual value
to the owner without a successor.  
**Verify:** Off-by-one and residual-capacity test matrix.  
**Exit gate:** A schedule executes exactly the requested number of payouts.

### Phase 34: Add Contract Property Tests

**Depends on:** Phases 29 and 33  
**Implement:** Generate mutations for capacity conservation, sequence, run count, policy hash,
payload hash, recipient, owner, reward, and successor count.  
**Verify:** Every mutation class yields a known rejection; valid generators remain valid.  
**Exit gate:** Invariants are tested beyond hand-picked examples.

### Phase 35: Add Contract Fuzz Harnesses

**Depends on:** Phase 34  
**Implement:** Fuzz Molecule parsing, witness mode dispatch, arithmetic boundaries, output matching,
and malformed transactions with reproducible seeds.  
**Verify:** CI smoke budget and longer scheduled campaign complete without crashes or hangs.  
**Exit gate:** Parser and arithmetic panics are treated as release blockers.

### Phase 36: Measure Script Cycles and Capacity

**Depends on:** Phases 29 and 33  
**Implement:** Benchmark each valid and worst-case invalid path; calculate occupied capacity for all
cells and payload variants.  
**Verify:** Machine-readable benchmark report compared to committed budgets.  
**Exit gate:** UI quotes and funding minimums use measured values.

### Phase 37: Make Contract Builds Reproducible

**Depends on:** Phase 36  
**Implement:** Pin the builder image/toolchain, normalize output, publish binary hashes, schema hash,
and source revision.  
**Verify:** Two clean builds produce identical artifacts and hashes.  
**Exit gate:** Testnet deployment artifacts are traceable to source.

### Phase 38: Deploy Contracts to a Local CKB Environment

**Depends on:** Phase 37  
**Implement:** Deploy scripts to the selected local chain harness and generate a local manifest with
code hashes, hash types, cell deps, and genesis identity.  
**Verify:** End-to-end raw transactions execute against deployed cells, not test-only binaries.  
**Exit gate:** SDK development has a real local deployment target.

### Phase 39: Publish Contract Specifications

**Depends on:** Phases 29, 33, and 38  
**Implement:** Document witness modes, schemas, invariants, output ordering policy, errors, deployment
manifest format, and recovery examples.  
**Verify:** A developer not involved in implementation reproduces one valid and one invalid vector.  
**Exit gate:** Contract behavior is not discoverable only by reading Rust source.

### Workstream D: Shared TypeScript SDK

### Phase 40: Implement Core Integer and Epoch Types

**Depends on:** Phases 12-13  
**Implement:** Add branded types and parsers for shannons, block numbers, epochs, hashes, outpoints,
sequences, and run counts without floating-point conversion.  
**Verify:** Boundary, serialization, and invalid-input tests.  
**Exit gate:** Money and chain counters cannot enter the SDK as unsafe JavaScript numbers.

### Phase 41: Implement Job Decoding and Inspection

**Depends on:** Phase 40  
**Implement:** Decode JobDataV1, derive policy metadata, validate deployment manifests, and return
typed unsupported-version results.  
**Verify:** Cross-language golden fixtures and malformed data.  
**Exit gate:** Browser and Node consumers receive the same inspection result.

### Phase 42: Implement Network Deployment Registry

**Depends on:** Phase 41  
**Implement:** Load signed/hashed manifests by genesis identity and expose script, dep, and
confirmation metadata.  
**Verify:** Wrong-network and altered-manifest tests fail closed.  
**Exit gate:** Code hashes are never copied ad hoc into application components.

### Phase 43: Implement Capacity and Quote Calculations

**Depends on:** Phases 36 and 40  
**Implement:** Calculate occupied capacity, application amount, rewards, residual refund, estimated
fee range, and maximum locked total.  
**Verify:** SDK results match contract benchmark fixtures.  
**Exit gate:** The same quote logic supports frontend and API validation.

### Phase 44: Implement Deadline Creation Builder

**Depends on:** Phases 29 and 42-43  
**Implement:** Build the unsigned campaign plus deadline Job Cell transaction and normalized intent.  
**Verify:** Local-chain dry run and byte-level expected fixture.  
**Exit gate:** CCC can complete owner inputs and fees without changing committed outputs.

### Phase 45: Implement Recurring Creation Builder

**Depends on:** Phases 33 and 42-43  
**Implement:** Build the unsigned recurring Job Cell transaction with fixed recipient, amount,
schedule, runs, rewards, and owner path.  
**Verify:** Local-chain dry run and expected policy hash.  
**Exit gate:** The displayed intent can be reconstructed from the transaction alone.

### Phase 46: Implement Cancellation Builder

**Depends on:** Phases 22 and 42  
**Implement:** Resolve the live outpoint and build the owner-signed cancellation/refund transaction.  
**Verify:** Stale outpoint and owner mismatch return actionable errors.  
**Exit gate:** Cancellation works without API-specific authorization.

### Phase 47: Implement Recovery Builder

**Depends on:** Phases 23 and 42  
**Implement:** Build each supported owner recovery mode with explicit reason and output preview.  
**Verify:** Local-chain recovery from every funded contract state.  
**Exit gate:** A standalone CLI can invoke the same builder.

### Phase 48: Implement Top-Up Builder

**Depends on:** Phases 24 and 42  
**Implement:** Build an owner-signed top-up that preserves immutable intent and updates allowed
budget fields only.  
**Verify:** Transaction diff inspector confirms unchanged commitments.  
**Exit gate:** Top-up cannot be confused with edit or migration.

### Phase 49: Implement Executor Adapter Interface

**Depends on:** Phases 41-43  
**Implement:** Add deterministic inspect, eligibility, build, and verify-built interfaces plus
deadline and recurring registrations.  
**Verify:** Identical snapshot and executor identity produce identical policy outputs.  
**Exit gate:** The executor contains no policy-specific branching outside adapters.

### Phase 50: Implement Deadline Executor Adapter

**Depends on:** Phases 44 and 49  
**Implement:** Resolve campaign state, determine objective outcome, build finalization, bind executor
reward, and self-verify.  
**Verify:** Success and refund fixtures dry-run locally.  
**Exit gate:** The adapter rejects an API/indexer claim not supported by transaction inputs.

### Phase 51: Implement Recurring Executor Adapter

**Depends on:** Phases 45 and 49  
**Implement:** Resolve the live job, derive payout and successor/final state, bind reward, and
self-verify.  
**Verify:** First, middle, late, and final executions dry-run locally.  
**Exit gate:** One adapter handles every sequence without mutable off-chain schedule state.

### Phase 52: Add SDK Conformance Fixtures

**Depends on:** Phases 44-51  
**Implement:** Publish valid and invalid JSON/binary/transaction fixtures shared by contracts, SDK,
API, executor, and frontend.  
**Verify:** Every consumer runs the same fixture suite in CI.  
**Exit gate:** Cross-layer drift fails before deployment.

### Phase 53: Add Recovery CLI

**Depends on:** Phases 46-47  
**Implement:** Provide inspect, cancel, recover, and unsigned-export commands using public RPC and
manifest inputs.  
**Verify:** Run from a clean environment while API, database, and Redis are stopped.  
**Exit gate:** Owner recovery does not depend on the hosted product.

### Workstream E: NestJS API and Indexer

### Phase 54: Scaffold the NestJS API

**Depends on:** Phases 03 and 08  
**Implement:** Create the API app, global validation, version prefix, shutdown hooks, and structured
bootstrap using the pinned NestJS platform adapter.  
**Verify:** Unit bootstrap and production build.  
**Exit gate:** Invalid configuration prevents the listener from starting.

### Phase 55: Add Health and Readiness

**Depends on:** Phases 07 and 54  
**Implement:** Separate liveness from readiness and report PostgreSQL, Redis, RPC, deployment
manifest, and index-lag status without leaking secrets.  
**Verify:** Dependency failure matrix changes readiness but not process liveness.  
**Exit gate:** Deployment automation can distinguish restart from dependency outage.

### Phase 56: Add Database Schema and Migration Runner

**Depends on:** Phases 07 and 54  
**Implement:** Create Section 11 tables, constraints, indexes, migration journal, and transactional
startup policy.  
**Verify:** Migrate empty database, rollback where supported, and migrate from previous fixture.  
**Exit gate:** Application startup never silently mutates schema outside migrations.

### Phase 57: Implement Network Metadata API

**Depends on:** Phases 42, 54, and 56  
**Implement:** Expose network/genesis identity, tip, confirmation depth, deployment manifest hash,
and supported policy versions.  
**Verify:** Response matches direct RPC and configured manifest.  
**Exit gate:** Frontend can detect wrong network before building a transaction.

### Phase 58: Implement the CKB Client Abstraction

**Depends on:** Phase 54  
**Implement:** Wrap `@ckb-ccc/shell` clients for RPC, indexer, dry-run, send, status, retry-safe reads,
timeouts, and endpoint rotation.  
**Verify:** Mock RPC contract tests cover success, timeout, malformed response, and endpoint failure.  
**Exit gate:** No feature module calls raw RPC directly.

### Phase 59: Implement Canonical Block Checkpoints

**Depends on:** Phases 56 and 58  
**Implement:** Persist processed block number/hash and a bounded canonical rollback window.  
**Verify:** Restart resumes exactly; changed parent hash triggers controlled rollback.  
**Exit gate:** Index progress is durable and network-specific.

### Phase 60: Implement Job Cell Discovery

**Depends on:** Phases 41, 58, and 59  
**Implement:** Discover supported Job Lock cells, decode versions, and store source outpoint and block
provenance idempotently.  
**Verify:** Duplicate scans produce no duplicate jobs or events.  
**Exit gate:** The database projection can be deleted and rebuilt from chain data.

### Phase 61: Implement Job Transition Indexing

**Depends on:** Phase 60  
**Implement:** Link consumed job outpoints to terminal or successor outputs and record immutable
version history.  
**Verify:** One-shot, recurring, cancelled, recovered, and consumed-by-other fixtures.  
**Exit gate:** Current state and complete history agree after replay.

### Phase 62: Implement Reorg Rollback

**Depends on:** Phases 59-61  
**Implement:** Mark orphaned events, roll projections back transactionally, and replay the new
canonical branch without deleting historical evidence.  
**Verify:** Synthetic reorg before and after a job execution.  
**Exit gate:** An orphaned commit is never displayed as confirmed.

### Phase 63: Implement Job Read Endpoints

**Depends on:** Phases 60-62  
**Implement:** Add list, detail, owner, template, filters, and stable cursor pagination with source
provenance.  
**Verify:** OpenAPI contract, pagination stability, and large-integer serialization.  
**Exit gate:** Frontend needs no direct database knowledge.

### Phase 64: Implement Job Event Endpoints

**Depends on:** Phase 61  
**Implement:** Expose indexed and operational events with category, confidence, block reference,
attempt reference, and replacement linkage.  
**Verify:** Reorg and retry histories remain ordered and unambiguous.  
**Exit gate:** Timeline clients can distinguish chain events from executor observations.

### Phase 65: Implement Quote Endpoints

**Depends on:** Phases 43 and 57  
**Implement:** Quote capacity, payout total, rewards, residual refund, approximate timing, fee range,
snapshot, and quote expiry for both workflows.  
**Verify:** API quote matches direct SDK calculation for shared fixtures.  
**Exit gate:** Stale quotes are rejected before signing.

### Phase 66: Implement Unsigned Transaction Endpoints

**Depends on:** Phases 44-48 and 65  
**Implement:** Add create, cancel, recover, top-up, and signed-transaction validation endpoints with
normalized intent hashes.  
**Verify:** Server output passes SDK self-verification and local dry run.  
**Exit gate:** API cannot return a transaction whose intent differs from its quote.

### Phase 67: Generate and Lock the OpenAPI Client

**Depends on:** Phases 63-66  
**Implement:** Generate OpenAPI in CI, produce the typed frontend client, and fail on uncommitted
schema drift.  
**Verify:** Regeneration is deterministic and frontend typecheck consumes only the generated client.  
**Exit gate:** API changes cannot silently break the web app.

### Phase 68: Add Server-Sent Events

**Depends on:** Phase 64  
**Implement:** Stream job and transaction-event notifications with reconnect cursor, heartbeat, and
authorization-free public job data.  
**Verify:** Disconnect/reconnect delivers missed events once by event ID.  
**Exit gate:** The dashboard updates without aggressive polling.

### Phase 68A: Implement Wallet Challenge Authentication

**Depends on:** Phases 40, 54, and 56  
**Implement:** Issue short-lived, single-use, domain- and network-separated challenges; verify CCC
message signatures; and create an address-scoped session for off-chain settings only.  
**Verify:** Replay, expiry, wrong address, wrong domain, wrong network, and malformed signature tests.  
**Exit gate:** An authenticated session cannot authorize or substitute for an on-chain transaction.

### Phase 68B: Implement Notification Preferences

**Depends on:** Phase 68A  
**Implement:** Add owner-scoped browser/email preference records for ready, submitted, confirmed,
failed, budget-low, cancelled, and recovery-required events.  
**Verify:** Authorization, opt-in, opt-out, address isolation, and retention tests.  
**Exit gate:** No notification channel is enabled without explicit user action.

### Phase 68C: Implement Signed Webhook Delivery

**Depends on:** Phases 64, 68A, and 68B  
**Implement:** Add webhook registration, encrypted secret storage, signed payloads, idempotency keys,
bounded retries, disablement, delivery history, and event replay.  
**Verify:** Signature verification, endpoint timeout, duplicate delivery, secret rotation, and
permanent-failure tests.  
**Exit gate:** Webhooks remain notifications and are never consumed as on-chain trigger proof.

### Phase 68D: Add API Abuse Controls

**Depends on:** Phases 63-68C  
**Implement:** Add request-size limits, rate limits, CORS allowlists, security headers, endpoint
timeouts, pagination caps, validation, and separate limits for transaction construction and auth.  
**Verify:** Boundary and bypass tests from direct and proxied client addresses.  
**Exit gate:** Unauthenticated traffic cannot create unbounded database, RPC, queue, or memory work.

### Phase 68E: Instrument the Backend

**Depends on:** Phases 55, 61, 68, and 68D  
**Implement:** Add correlation IDs, structured redacted logs, OpenTelemetry traces, Section 18 metrics,
queue instrumentation, RPC timing, and error reporting release metadata.  
**Verify:** One test job can be followed from indexing through API, queue, executor, and confirmation
without logging secrets or raw authorization material.  
**Exit gate:** Operators can diagnose a failed job without querying production tables manually.

### Phase 68F: Add Backend Integration Tests

**Depends on:** Phases 56-68E  
**Implement:** Test API, database migrations, index replay, Redis queues, auth, webhooks, SSE, and
mocked CKB RPC as a composed NestJS system.  
**Verify:** Fresh and migrated databases run the same suite; tests are deterministic in CI.  
**Exit gate:** Every public endpoint and background module has a successful and failing integration
path.

### Workstream F: Durable Executor

### Phase 69: Scaffold the NestJS Executor

**Depends on:** Phases 54 and 58  
**Implement:** Create a standalone Nest application context with shared configuration, chain client,
adapters, graceful shutdown, and no public HTTP listener.  
**Verify:** Process starts, reports readiness, and shuts down without abandoning active work.  
**Exit gate:** API and executor can deploy and restart independently.

### Phase 70: Configure BullMQ Queues

**Depends on:** Phases 07 and 69  
**Implement:** Define discovery, evaluate, build, submit, confirm, notify, and dead-letter queues with
stable job IDs, retry limits, and retention.  
**Verify:** Restart Redis clients during controlled jobs and confirm work resumes.  
**Exit gate:** Process memory is not the only record of pending execution work.

### Phase 71: Implement Eligibility Evaluation

**Depends on:** Phases 49, 60, and 70  
**Implement:** Enqueue live jobs, derive eligibility from the current chain tip and policy adapter,
and schedule the next evaluation as a wake-up hint.  
**Verify:** Server clock skew does not make an ineligible transaction pass dry-run.  
**Exit gate:** Only chain-valid lower bounds move jobs to READY.

### Phase 72: Implement Transaction Build Work

**Depends on:** Phases 50-51 and 71  
**Implement:** Lock one operational attempt, reload the live outpoint, invoke the deterministic
adapter, add executor fee inputs/change, and self-verify outputs.  
**Verify:** Stale outpoint and duplicate queue deliveries produce no duplicate valid action.  
**Exit gate:** Every built transaction records its exact chain snapshot and intent hash.

### Phase 73: Implement Dry-Run and Profitability Gate

**Depends on:** Phase 72  
**Implement:** Call `dry_run_transaction`, enforce cycle/fee limits, verify reward output, and compare
posted reward to configured minimum margin.  
**Verify:** Simulation rejection and uneconomic rewards never reach submission.  
**Exit gate:** Executor fee funds cannot be drained by known-invalid work.

### Phase 74: Implement Submission

**Depends on:** Phase 73  
**Implement:** Broadcast through configured nodes, preserve the signed transaction hash, classify
duplicate-known responses, and create a submission event.  
**Verify:** Endpoint timeout after successful acceptance is resolved by hash lookup, not blind rebuild.  
**Exit gate:** At-least-once queue delivery does not create uncontrolled resubmission.

### Phase 75: Implement Confirmation Tracking

**Depends on:** Phase 74  
**Implement:** Track pending, proposed, committed, confirmation depth, rejected, dropped, and
conflicted states through RPC plus indexer evidence.  
**Verify:** Fixture transitions and temporary RPC disagreement.  
**Exit gate:** UI receives confirmed only after configured canonical depth.

### Phase 76: Implement Retry Classification

**Depends on:** Phase 75  
**Implement:** Map failures to retryable, terminal-invalid, consumed-by-other, unsupported,
cancelled, expired, or recovery-required with bounded exponential backoff and jitter.  
**Verify:** Every failure code has a retry policy test.  
**Exit gate:** Permanent invalid work cannot loop indefinitely.

### Phase 77: Implement Contention Handling

**Depends on:** Phases 72-76  
**Implement:** Detect competing spends, resolve the canonical consuming transaction, attribute the
winning executor when possible, and close losing attempts cleanly.  
**Verify:** Two executor instances race the same local-chain job.  
**Exit gate:** Competition yields one state transition and accurate losing receipts.

### Phase 78: Implement Reorg Recovery

**Depends on:** Phases 62 and 75  
**Implement:** Return orphaned committed attempts to evaluation only when the original live input is
again canonical and unspent.  
**Verify:** Reorged execution with and without a competing replacement.  
**Exit gate:** Reorg recovery cannot duplicate an already canonical successor.

### Phase 79: Implement Executor Receipts

**Depends on:** Phases 75-78  
**Implement:** Sign non-authoritative receipts containing job, sequence, attempt, transaction,
executor, timestamps, chain references, outcome, and software version.  
**Verify:** Signature and tamper tests; receipt never overrides chain state.  
**Exit gate:** Operational evidence is portable and independently verifiable.

### Phase 80: Implement Dead-Letter Operations

**Depends on:** Phase 76  
**Implement:** Persist exhausted jobs, expose protected inspect/replay/close commands, and require an
operator reason for replay.  
**Verify:** Replay is idempotent and fully audited.  
**Exit gate:** Failed work is visible and recoverable without database editing.

### Workstream G: Next.js Product Interface

### Phase 81: Scaffold the Next.js Application

**Depends on:** Phases 03 and 67  
**Implement:** Create App Router structure, route groups, typed environment, error boundaries,
loading shells, metadata, and generated API client integration.  
**Verify:** Build, lint, typecheck, and route smoke tests.  
**Exit gate:** No wallet code is imported by a Server Component.

### Phase 82: Establish the Visual System

**Depends on:** Phase 81  
**Implement:** Define neutral surfaces, semantic status colors, typography, spacing, focus rings,
icons, form controls, tables, drawers, dialogs, and responsive dimensions.  
**Verify:** Story fixtures at desktop and mobile widths with long values and large numbers.  
**Exit gate:** Components remain legible without color and without layout shift.

### Phase 83: Build the Application Shell

**Depends on:** Phase 82  
**Implement:** Add desktop navigation, compact mobile navigation, page header, network badge, wallet
area, global notifications, and content constraints.  
**Verify:** Keyboard navigation, 320px mobile, tablet, desktop, and wide desktop screenshots.  
**Exit gate:** Navigation never overlaps content or hides primary actions.

### Phase 84: Integrate the CCC Provider

**Depends on:** Phase 83  
**Implement:** Add a dedicated client component wrapping `ccc.Provider`, explicit public-testnet
client, app identity, wallet filters, and preferred network settings.  
**Verify:** Supported wallets open, connect, restore, disconnect, and expose a signer under App Router.  
**Exit gate:** Wrong-network state is visible before any form can proceed to signing.

### Phase 85: Build Wallet and Network Controls

**Depends on:** Phases 57 and 84  
**Implement:** Show shortened address, wallet name, network, balance, copy/explorer actions, switch
guidance, and disconnected state.  
**Verify:** Missing extension, rejected connection, wrong network, zero balance, and reconnect cases.  
**Exit gate:** A user cannot mistake testnet for mainnet.

### Phase 86: Build the Automation Dashboard

**Depends on:** Phases 63, 67, and 83  
**Implement:** Add owner-scoped and public-demo views, status summary, next action, next eligibility,
funded value, filters, pagination, and empty/loading/error states.  
**Verify:** Fixture states include every lifecycle and operational status.  
**Exit gate:** The first screen is useful without reading explanatory marketing content.

### Phase 87: Build the Template Gallery

**Depends on:** Phase 83  
**Implement:** Present deadline and recurring templates as available and NervDAO as research-only,
with concise risk, approval, and recoverability information.  
**Verify:** Users can distinguish executable, demo-only, and research templates in usability review.  
**Exit gate:** An unavailable template has no misleading create action.

### Phase 88: Build Shared Setup Stepper

**Depends on:** Phases 82 and 87  
**Implement:** Add template, details, timing, funding, review, wallet approval, and result steps with
URL-safe progress and unsaved-change protection.  
**Verify:** Back/forward navigation preserves valid input and focuses the first error.  
**Exit gate:** Each screen asks one coherent group of questions.

### Phase 89: Build Deadline Setup Form

**Depends on:** Phases 65 and 88  
**Implement:** Collect campaign outcome parameters, recipient/refund information, block deadline,
reward, and owner path using plain language.  
**Verify:** Client and API reject the same invalid fixtures.  
**Exit gate:** No raw script field is required from a normal user.

### Phase 90: Build Recurring Setup Form

**Depends on:** Phases 65 and 88  
**Implement:** Collect recipient, amount, first execution, interval, run count, reward, and owner
refund behavior with total-funding preview.  
**Verify:** Large amounts, low balance, invalid address, zero interval, and excessive runs.  
**Exit gate:** Total locked value is understood before review.

### Phase 91: Build Human-Readable Review

**Depends on:** Phases 66 and 89-90  
**Implement:** Use CCC to complete owner inputs, fee, and change without signing; then render the
exact completed transaction's normalized intent, immutable terms, amounts, timing uncertainty,
reward, fee, recovery, network, change, and expandable technical details.  
**Verify:** UI reconstructs and compares the policy intent hash returned by the API, while allowing
only the documented owner inputs, fee, and change additions.  
**Exit gate:** Any transaction/policy mismatch blocks review completion and wallet invocation.

### Phase 92: Implement CCC Signing and Submission

**Depends on:** Phases 84 and 91  
**Implement:** Freeze the reviewed unsigned transaction, revalidate its full hash and
policy-critical outputs, invoke the CCC signer without rebuilding, submit, and persist the
transaction hash locally for recovery after navigation.  
**Verify:** Approve, reject, wallet close, stale quote, stale input, RPC error, and resubmission cases.  
**Exit gate:** A rejected signature creates no false job or success message.

### Phase 93: Build Transaction Progress

**Depends on:** Phases 68, 75, and 92  
**Implement:** Show submitted, proposed, committed, confirmed, dropped, conflicted, and reorged
states using SSE with polling fallback and explorer link.  
**Verify:** Refresh and reconnect preserve accurate progress.  
**Exit gate:** Only confirmation-depth completion uses success styling.

### Phase 94: Build Job Detail and Timeline

**Depends on:** Phases 64, 68, and 93  
**Implement:** Show status, policy summary, funds, schedule, sequence, next execution, source
outpoint, event timeline, attempts, receipts, and technical details.  
**Verify:** One-shot, recurring, cancelled, conflicted, dropped, reorged, and unsupported fixtures.  
**Exit gate:** Users can determine what happened and what they can do next.

### Phase 95: Build Cancel, Recover, and Top-Up Flows

**Depends on:** Phases 66, 91-94  
**Implement:** Add separate owner review dialogs and CCC signing flows; explain races and refresh the
live outpoint immediately before signing.  
**Verify:** Successful action, lost race, stale state, wrong owner, rejected signature, and recovery
without executor availability.  
**Exit gate:** Escape actions are as discoverable and understandable as creation.

### Phase 95A: Build the Activity View

**Depends on:** Phases 64, 68, and 94  
**Implement:** Add filterable transaction/execution history grouped by job, with outcome, confidence,
block reference, executor receipt, explorer action, and stable pagination.  
**Verify:** Submitted, confirmed, losing contention, dropped, reorged, cancelled, and recovery events.  
**Exit gate:** Activity never merges an operational attempt with a canonical chain result.

### Phase 95B: Build Settings and Notifications

**Depends on:** Phases 68A-68C and 85  
**Implement:** Add address-authenticated notification settings, webhook management, privacy summary,
network information, session sign-out, and destructive preference reset.  
**Verify:** Auth expiry, address switch, webhook secret rotation, opt-out, and mobile layouts.  
**Exit gate:** One wallet cannot read or change another address's private preferences.

### Phase 95C: Build the NervDAO Research Preview

**Depends on:** Phases 82-83 and the canonical project documentation  
**Implement:** Add the non-transactional Cycle Guard/Harvest explanation, illustrative epoch
calculator, annualized-return warning, security prerequisites, and research-source links.  
**Verify:** Page contains no create, sign, schedule, or guaranteed-return action or claim.  
**Exit gate:** Users can distinguish a researched future adapter from an implemented automation.

### Phase 95D: Add Frontend Unit and Component Tests

**Depends on:** Phases 86-95C  
**Implement:** Cover formatters, intent comparison, forms, status mapping, accessibility behavior,
wallet states, SSE reducers, error recovery, and demo/live data-provider separation.  
**Verify:** Tests fail for changed policy fields, mislabeled confirmation, missing demo label, and
unsafe integer conversion.  
**Exit gate:** Policy-critical presentation logic is not protected only by browser E2E tests.

### Phase 95E: Add Local Playwright Journeys

**Depends on:** Phases 92-95D  
**Implement:** Automate both setup flows, wallet approval/rejection harnesses, transaction progress,
successor display, cancellation, recovery, Activity, Settings, and responsive viewports.  
**Verify:** Run against deterministic local API/chain fixtures with screenshots and traces on failure.  
**Exit gate:** The complete product flow is reproducible before public testnet deployment.

### Workstream H: Product Completion and Release Evidence

### Phase 96: Add Explicit Demo Mode

**Depends on:** Phases 86-95  
**Implement:** Add seeded guided scenarios, visible “Demo data” treatment, reset control, and a
strict data-provider boundary preventing fixtures from entering live testnet views.  
**Verify:** Automated assertions ensure every demo page retains the label and no fixture emits a
testnet explorer claim.  
**Exit gate:** Presenters can demonstrate the full UI without misrepresenting simulated evidence.

### Phase 97: Complete Accessibility Remediation

**Depends on:** Phase 96  
**Implement:** Complete semantic labels, focus management, contrast, reduced motion, error
announcements, touch targets, and responsive text behavior.  
**Verify:** Automated accessibility checks plus keyboard-only and screen-reader walkthroughs.  
**Exit gate:** No critical accessibility failure remains in either primary flow.

### Phase 98: Run Nontechnical Usability Tests

**Depends on:** Phase 97  
**Implement:** Run a five-person task-based study covering wallet connection, both creation flows,
status interpretation, cancellation, recovery discovery, and demo/live distinction.  
**Verify:** Record completion, hesitation, error, and comprehension results without coaching.  
**Exit gate:** At least four of five users complete both primary flows without developer intervention.

### Phase 99: Remediate Usability Findings

**Depends on:** Phase 98  
**Implement:** Fix blocking and high-impact findings, update copy and interaction tests, and document
deferred low-impact findings with rationale.  
**Verify:** Re-run each failed task with affected participants or equivalent first-time users.  
**Exit gate:** No unresolved finding prevents setup, status understanding, cancellation, or recovery.

### Phase 100: Deploy Testnet Contracts

**Depends on:** Phases 37, 39, and 99  
**Implement:** Deploy reproducible script binaries to the selected public testnet and publish the
network/genesis-bound manifest, deployment transactions, binary hashes, and schema hash.  
**Verify:** Independently resolve every code dep and execute one raw fixture against each script.  
**Exit gate:** Applications consume only the published manifest, not locally copied hashes.

### Phase 101: Provision Public Data Services

**Depends on:** Phases 55, 62, and 100  
**Implement:** Deploy PostgreSQL, Redis, API, TLS, backups, migration job, health probes, log sinks,
metrics, and alerts in the public showcase environment.  
**Verify:** Readiness, migration, backup, restore, and dependency-failure checks.  
**Exit gate:** The API can rebuild and serve the canonical testnet read model.

### Phase 102: Deploy the Public Frontend

**Depends on:** Phases 99-101  
**Implement:** Deploy the Next.js application with explicit testnet configuration, CSP/security
headers, API/SSE endpoints, wallet metadata, analytics consent, and limitations link.  
**Verify:** Desktop/mobile browser smoke tests and network/manifest identity checks.  
**Exit gate:** The public URL cannot silently connect to another chain or backend environment.

### Phase 103: Provision Independent Executors

**Depends on:** Phases 77, 80, and 101  
**Implement:** Deploy two separately identified executor instances with capped fee wallets,
independent health checks, supported-policy configuration, and operator rotation procedure.  
**Verify:** Each executor can operate alone and both can compete for the same eligible job.  
**Exit gate:** The showcase does not depend on one executor process or one fee key.

### Phase 104: Run Public End-to-End Acceptance

**Depends on:** Phases 102-103  
**Implement:** Execute campaign success, campaign refund, recurring first/middle/final runs,
cancellation, recovery, top-up, and demo-mode scenarios from the public UI.  
**Verify:** Record public transaction hashes, screenshots, receipts, and expected database events.  
**Exit gate:** Both automation families work without developer-only transaction tools.

### Phase 105: Run Operational Failure Drills

**Depends on:** Phase 104  
**Implement:** Exercise API restart, executor restart, Redis interruption, RPC rotation, dead-letter
replay, stale quote, competing execution, backup restore, and simulated index rollback.  
**Verify:** Compare observed recovery with runbook steps and service objectives.  
**Exit gate:** No drill requires direct production-database editing or a user key.

### Phase 106: Complete the Seven-Day Testnet Soak

**Depends on:** Phase 105  
**Implement:** Run scheduled deadline and recurring jobs throughout seven consecutive days, retain
metrics and incidents, and prohibit silent resets of failed evidence.  
**Verify:** Check uptime, index lag, queue age, attempts, confirmations, rewards, and state parity.  
**Exit gate:** No unexplained divergence exists between CKB and the product read model.

### Phase 107: Perform the Security Review

**Depends on:** Phase 106  
**Implement:** Review contract invariants, transaction intent, wallet boundary, API validation,
indexer/reorg logic, queue idempotency, permissions, dependencies, secrets, and deployment controls.  
**Verify:** Findings include severity, exploit narrative, affected artifact, and reproducible evidence.  
**Exit gate:** Every finding has an owner and remediation decision.

### Phase 108: Remediate Security Findings

**Depends on:** Phase 107  
**Implement:** Fix all critical/high findings and accepted lower-severity issues; add a regression
test for every code-level finding and document any residual risk.  
**Verify:** Reviewer retest plus the complete affected test matrix.  
**Exit gate:** No unresolved critical or high-severity finding remains.

### Phase 109: Prove Independent Recovery

**Depends on:** Phase 108  
**Implement:** Stop the hosted frontend, API, executor, database, and Redis, then inspect and recover
a funded testnet job with the published manifest, recovery CLI, public RPC, and owner wallet.  
**Verify:** Preserve commands, transaction hash, outputs, and third-party witness notes.  
**Exit gate:** Hosted Automata availability is not required to exit a funded job.

### Phase 110: Complete Operator and User Documentation

**Depends on:** Phases 105 and 109  
**Implement:** Finalize deployment, monitoring, incident, dead-letter, key rotation, backup/restore,
owner recovery, user help, privacy, limitations, and reset guides.  
**Verify:** A new operator follows the runbook in a clean environment without verbal assistance.  
**Exit gate:** Operational knowledge is not held only by the implementation team.

### Phase 111: Complete the Presenter Package

**Depends on:** Phases 104 and 110  
**Implement:** Create the presentation script, pre-funded scenarios, reset checklist, fallback demo
path, expected transaction timing, and truthful limitations statement.  
**Verify:** A non-developer presenter runs the complete demonstration twice.  
**Exit gate:** The presentation does not depend on hidden developer tools or unlabeled simulated data.

### Phase 112: Build the Release Candidate

**Depends on:** Phases 106, 108, 110, and 111  
**Implement:** Freeze dependency and contract artifacts, generate release notes, assemble evidence,
publish checksums, and deploy the exact candidate to a clean preview environment.  
**Verify:** All deterministic checks pass from clean checkout and artifacts match the public manifest.  
**Exit gate:** The candidate is reproducible and no unreviewed code remains.

### Phase 113: Run Final Acceptance and Tag the Showcase

**Depends on:** Phase 112  
**Implement:** Re-run every Section 2 acceptance item, both live workflows, recovery evidence, UI
viewport checks, limitations review, and source/artifact linkage. Tag the accepted source revision.  
**Verify:** Product, contract, backend, frontend, security, and operations sign the evidence record.  
**Exit gate:** The release is labeled accurately as a working testnet showcase, not audited
production software.

---

## 15. Cross-Phase Test Matrix

| Layer | Required coverage |
|---|---|
| Molecule | Cross-language golden vectors, malformed/truncated input, unsupported versions |
| Job Lock | Owner, executor, reward binding, conservation, successor count, cancellation, recovery |
| Deadline policy | Before/at/after deadline, success, failure, wrong campaign, wrong outputs |
| Recurring policy | First/middle/final run, late execution, exact payout, sequence, budget, residual |
| SDK | Integer safety, manifests, quotes, builders, intent hashes, wrong network, stale cells |
| Indexer | Replay, idempotency, checkpoint restart, rollback, replacement branch, malformed cells |
| API | DTO validation, OpenAPI, auth challenges, rate limits, pagination, provenance, large integers |
| Executor | duplicate work, dry-run failure, RPC timeout, contention, drop, conflict, restart, reorg |
| Frontend | disconnected, wrong network, empty/error/loading, wallet rejection, signing mismatch |
| Browser E2E | both create flows, execution, successor, cancellation, recovery, demo/live separation |
| Operations | backup/restore, secret rotation, paused executor, dead letter, second executor, rollback |

## 16. Required Validation Commands

The exact script names are established during workspace scaffolding, but the final root interface
must provide these stable commands:

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm api:generate
pnpm api:check
pnpm schema:generate
pnpm schema:check
pnpm contracts:build
pnpm contracts:test
pnpm contracts:bench
pnpm test:local-chain
pnpm build
pnpm verify
```

`pnpm verify` must aggregate all deterministic checks suitable for CI. Public testnet tests remain a
separate opt-in command and must never be reported as run when only fixtures or a local chain ran.

## 17. Security Review Checklist

- No user secret crosses the browser boundary.
- Every wallet transaction has a locally reconstructed intent summary.
- Network/genesis identity and deployment manifest are checked before building or signing.
- Contract arithmetic is checked and uses integer units.
- Executor reward cannot be redirected by transaction copying.
- Fee inputs and change cannot alter policy-controlled outputs.
- One live Job Cell can produce at most one canonical transition.
- Recurrence creates exactly one constrained successor.
- Cancellation and recovery cannot pay executor rewards.
- Owner recovery works without the API, database, Redis, or hosted frontend.
- Indexer reorg rollback is transactional and observable.
- Queue delivery is idempotent and bounded.
- Auth challenges expire, are single-use, network-bound, and domain-separated.
- Public endpoints have validation, request limits, timeouts, and abuse controls.
- Logs, traces, analytics, and error reporting redact addresses only where promised and always redact
  secrets, signatures, authorization headers, and raw private configuration.
- Demo fixtures cannot enter live projections or transaction claims.
- Executor fee wallets are capped, monitored, and independently rotatable.
- Deployed binaries, schemas, manifests, and source revisions are reproducibly linked.

## 18. Observability and Service Objectives

### 18.1 Metrics

```text
automata_indexer_tip_lag_blocks
automata_jobs_live_total
automata_jobs_ready_total
automata_attempts_total{policy,outcome}
automata_execution_latency_blocks
automata_dry_run_failures_total{code}
automata_queue_depth{queue}
automata_queue_oldest_seconds{queue}
automata_reorgs_total
automata_rpc_errors_total{endpoint,method}
automata_rewards_earned_shannons_total
automata_webhook_deliveries_total{outcome}
```

### 18.2 Showcase objectives

- API read availability target: 99.5% during the public demonstration window.
- Index lag alert: more than five blocks for five minutes.
- Eligible-job alert: no attempt within three blocks when the reward is above the operator minimum.
- Confirmation presentation: never before the configured depth.
- Recovery objective: rebuild the complete read model from CKB within the documented window.
- Queue recovery objective: unfinished work resumes after an executor restart without manual edits.

These are operational targets for the testnet showcase, not financial or execution guarantees.

## 19. Deployment Environments

| Environment | Chain | Purpose | Data |
|---|---|---|---|
| Unit | Test fixtures | Pure package and contract behavior | Ephemeral |
| Local integration | Local CKB harness | Cross-layer development | Resettable |
| Preview | CKB testnet | Per-change wallet and deployment review | Isolated prefix/schema |
| Public showcase | CKB testnet | Stable demonstration and soak | Backed up operational index |

No environment in this plan targets CKB mainnet. Adding mainnet requires a separate audited release
plan, explicit contract deployment governance, larger security review, incident process, and owner
migration strategy.

## 20. Demonstration Script

The final presentation should prove behavior, not only show screens:

1. Open the dashboard in live testnet mode.
2. Connect a wallet and show the explicit network identity.
3. Create a three-run recurring payment with a short testnet block interval.
4. Read the signing summary aloud and approve in the wallet.
5. Show the submitted transaction progressing to confirmed.
6. Show the first executor action, recipient payment, reward, and successor Job Cell.
7. Open a pre-funded deadline campaign and show objective finalization.
8. Start a second executor to demonstrate permissionless contention and one canonical winner.
9. Cancel the remaining recurring schedule and show the owner refund.
10. Open the recovery CLI/runbook to prove hosted-service independence.
11. Switch to demo mode and show that simulated data is labeled.
12. End on the limitations page: testnet, unaudited, no mainnet funds, no DAO harvest implementation.

## 21. Release Artifacts

- Tagged source revision.
- `pnpm-lock.yaml`, `Cargo.lock`, and pinned toolchain files.
- Reproducible contract binaries and SHA-256 hashes.
- Molecule schema and generated bindings.
- Testnet deployment manifest with genesis and deployment transaction references.
- Generated OpenAPI document and typed client.
- Contract test vectors and benchmark report.
- Test summary separating unit, local-chain, preview, and public-testnet evidence.
- Threat model, review findings, fixes, and known limitations.
- Operator, recovery, deployment, reset, and presenter guides.
- Public transaction evidence for both automation families.
- Screenshots for supported desktop and mobile viewports.
- Data-retention and privacy statement.

## 22. Post-Showcase Decision Gate

The POC should not automatically become a production protocol. After the showcase, proceed only if:

- at least three independent CKB applications provide written integration intent;
- at least two application teams can map their workflow to the same lifecycle without weakening
  their own contract rules;
- measured reward and execution economics are positive for defined job sizes;
- users understand setup and recovery authority;
- an external reviewer agrees that the contract boundaries are suitable for a production audit; and
- maintainers are prepared to operate multiple executors and long-term recovery tooling.

If only one application wants the system, package its worker and policy locally rather than claiming
a shared protocol. If users want reminders but not constrained on-chain authority, narrow the
product to non-custodial notifications.

## 23. Primary Implementation References

- [Next.js App Router documentation](https://nextjs.org/docs/app)
- [Next.js installation and supported runtime](https://nextjs.org/docs/app/getting-started/installation)
- [CCC repository and package guidance](https://github.com/ckb-devrel/ccc)
- [CCC React connector documentation](https://github.com/ckb-devrel/ccc/blob/master/packages/docs/content/docs/packages/core-packages/connector-react.mdx)
- [CCC wallet connection guide](https://github.com/ckb-devrel/ccc/blob/master/packages/docs/content/docs/guides/connect-wallets.mdx)
- [NestJS BullMQ queue documentation](https://docs.nestjs.com/techniques/queues)
- [NestJS OpenAPI documentation](https://docs.nestjs.com/openapi/introduction)
- [NestJS database integration guidance](https://docs.nestjs.com/techniques/database)
- [`ckb-std`](https://github.com/nervosnetwork/ckb-std)
- [`ckb-testtool`](https://github.com/nervosnetwork/ckb-testtool)
- [CKB RFC 17: transaction `since`](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0017-tx-valid-since/0017-tx-valid-since.md)
- [CKB RFC 22: transaction structure](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0022-transaction-structure/0022-transaction-structure.md)
