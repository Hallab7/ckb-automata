# DAO Harvest V3 Adversarial Review

Review date: 2026-11-11

Scope: V3 Job Lock, policy, vault lock, compensation lock, operator accumulators, TypeScript
builders, wallet completion, canonical projection, executor runtime, and offline recovery tooling.

Reviewed baseline: `96ca970` plus the V3 fuzz and unknown-operation regressions introduced with
this report.

Reviewer: OpenAI Codex (GPT-5), with read/write access to the local repository and permission to
run the repository test, build, lint, fuzz, and contract commands.

This is an AI-assisted internal adversarial review. It is not an independent professional audit and
does not satisfy the audit gate for NervDAO integration or mainnet use.

## Review Method

- Trace every operation from Molecule decoding through Job, policy, vault, compensation, and DAO
  script validation.
- Mutate transaction-global indices, principal, locks, payload/progress commitments, credits,
  headers, `since`, service payments, accumulators, successor counts, and terminal layouts.
- Verify wallet completion can add only owner funding and change without moving reviewed inputs,
  protected outputs, dependencies, or witnesses.
- Verify the executor cannot select owner operations and must re-read all live inputs after dry-run.
- Rebuild index state from canonical transactions and reject malformed or contradictory evidence.
- Generate owner-exit and mature-recovery artifacts without the API, database, Redis, private key,
  or hosted executor.

## Findings

| ID       | Severity        | Status                    | Result                                                                                                                                                                                                                          |
| -------- | --------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V3-AR-01 | High            | Resolved                  | Deposited owner exit creates the exact same-capacity, same-index withdrawing DAO output under the ordinary owner lock. Real DAO mutation tests reject changed index, capacity, data, header, or owner.                          |
| V3-AR-02 | High            | Resolved                  | Final automated claim returns principal to an ordinary owner-locked DAO deposit and leaves no successor Job Cell.                                                                                                               |
| V3-AR-03 | High            | Resolved                  | V3 payload, progress, prepare credit, vault terms, and compensation bindings use separate domain hashes. Shadow payload and cross-version witnesses fail.                                                                       |
| V3-AR-04 | High            | Resolved                  | Owner completion has no claim-service payment. Principal is excluded from service payments and network fees in builders and contracts.                                                                                          |
| V3-AR-05 | High            | Resolved                  | Unsupported and state-invalid operations reject the atomic transaction. The Job and bound vault remain at their original live outpoints.                                                                                        |
| V3-AR-06 | Medium          | Accepted for testnet      | An approved prepare operator can still submit late because CKB `since` has no upper bound. Rotation, cutoff scheduling, alerts, and fallback operators limit liveness impact but cannot revoke a transaction already submitted. |
| V3-AR-07 | Medium          | Pending external evidence | Public V3 transaction decoding, offline recovery broadcast, alert delivery, two-operator contention, and the seven-day soak require the deployed testnet release.                                                               |
| V3-AR-08 | Release blocker | Pending independent work  | An independent professional audit of the final reproducible binaries is required before NervDAO integration ships.                                                                                                              |

## Residual Risk and Release Decision

V3 remains testnet-only and new setup must remain disabled until the versioned manifest is deployed,
public owner-path evidence is recorded, the seven-day soak passes, and the professional audit has no
unresolved critical or high finding. V1/V2 positions retain their immutable limitations and must not
be described as repaired by V3.
