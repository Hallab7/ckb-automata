# DAO Harvest Security Review

Review date: 2026-09-30

Scope: CKB testnet pilot only

Decision: Ready for integrated local verification. Public testnet acceptance remains pending.

## Review result

No open critical or high-severity finding remains in the reviewed implementation. This is not an
external audit and does not authorize mainnet use.

The review treats CKB consensus and live cells as authoritative. API rows, queue state, executor
receipts, browser storage, displayed dates, and wall-clock timers are supporting evidence only.

## Findings

| ID    | Severity | Status   | Finding and resolution                                                                                                                                                                                                                                                                    |
| ----- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DH-01 | High     | Resolved | Direct mature recovery previously accepted operator-entered DAO accumulated rates. The recovery CLI now reads both rates from the referenced public headers and the DAO script independently validates them.                                                                              |
| DH-02 | High     | Resolved | Direct mature recovery could be built without comparing the claim epoch to the public-chain tip. The SDK now rejects an early claim and the CLI derives the current epoch from `get_tip_header`.                                                                                          |
| DH-03 | Medium   | Accepted | CKB `since` cannot enforce the preparation cutoff. The approved prepare executor set, cutoff scheduler, missed-window rollover, pause procedure, and alert limit the risk. A malicious approved executor can still deliberately submit late. Protocol owner owns this testnet limitation. |
| DH-04 | Medium   | Pending  | Alert rules and notification mappings are implemented, but public delivery evidence depends on the deployed pilot runtime. Release owner must verify delivery during deployment acceptance. This does not block owner recovery.                                                           |
| DH-05 | Medium   | Pending  | A real DAO cycle, public transaction evidence, and seven-day soak are not local test evidence. Release owner must complete them before testnet pilot acceptance.                                                                                                                          |
| DH-06 | Low      | Accepted | Calendar times are estimates. Exact epoch fractions and canonical headers remain the execution authority. Frontend owner maintains the plain-language disclosure.                                                                                                                         |
| DH-07 | Low      | Accepted | `pnpm audit` reports GHSA-848j-6mx2-7j84 in transitive `elliptic` 6.6.1 with no published patched version. Dependency owner must track the upstream CKB SDK chain and re-run the audit before release. Mainnet remains disabled.                                                          |

## Integrated evidence

| Boundary      | Evidence                                                                            | What it proves                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract      | `cargo test-native --locked`                                                        | CKB-VM creation, prepare, claim/redeposit, owner exit, mutation rejection, and measured cycle limits.                                                                                   |
| SDK journey   | `dao-harvest-journey.test.ts`                                                       | Two linked cycles consume the prior outputs, preserve principal, pay exact compensation and rewards, charge only executor fees, and return the terminal Job Cell residual to the owner. |
| Range limits  | `dao-harvest-journey.test.ts`                                                       | Exact occupied-capacity principal and the maximum finite cycle counter serialize without truncation.                                                                                    |
| Scheduling    | `dao-harvest-scheduler.test.ts`                                                     | Early, open, cutoff, rollover, budget, authorization, contention, drop, and reorg decisions fail closed.                                                                                |
| Recovery      | `dao-harvest-recovery-cli.test.mjs`                                                 | Public RPC, manifest, owner lock, and live cells are sufficient; private keys and hosted CKAutomata services are not inputs.                                                            |
| API           | API HTTP security and DAO route tests                                               | Request limits, invalid hashes/cursors/bodies, origin policy, timeouts, rate limits, and unsigned-only mutations remain enforced.                                                       |
| Wallet review | DAO harvest form/review/submission tests                                            | Displayed principal, payout, cycles, charges, and required outputs are compared with the serialized transaction before signing.                                                         |
| Browser       | Playwright product and accessibility suites                                         | Desktop/mobile layout, keyboard use, loading/error states, touch targets, and serious accessibility violations are checked.                                                             |
| Supply chain  | lockfile, `pnpm audit --audit-level high`, secret scan, reproducible contract build | No high or critical advisory; one documented low advisory; committed secrets, compiler drift, and binary drift remain separate release gates.                                           |

## Failure conclusions

- Competing executors can spend fees, but CKB input uniqueness permits only one canonical successor.
- A reorganization removes application confidence until canonical live inputs and headers are read
  again. A signed executor receipt never overrides chain state.
- A missed preparation window delays harvesting to a later DAO cycle; it does not move principal.
- Exhausted rewards stop automation work and leave the owner stop/exit/recovery paths available.
- API, database, Redis, executor, and notification outages may delay automation but cannot authorize
  a different payout or prevent a valid owner transaction.
- Script retirement requires an owner-approved replacement automation. Operators cannot migrate
  funds under a new script on the owner's behalf.

## Release limits

Mainnet stays disabled. Testnet activation still requires reproducible deployed code hashes and
cell deps, a live setup/prepare/claim/redeposit cycle, decoded value-conservation evidence,
independent owner recovery, monitoring evidence, and the seven-day soak defined in the
implementation plan.
