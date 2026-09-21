# ADR 0007: Release to CKB Testnet Only

- Status: Accepted
- Date: 2026-09-21
- Scope: Showcase deployment and product claims

## Context

The project is a working proof of concept for constrained automation, not an
audited production protocol. Contract, executor, recovery, reorg, usability,
economics, and multi-operator evidence must be established before real-value
deployment can be responsibly considered.

## Decision

Deploy and present this release only on CKB testnet. The UI, API, manifests,
documentation, and presenter material must identify the network and the
unaudited status. Mainnet endpoints and manifests are not supported defaults.
Demo fixtures must remain visibly separate from live testnet evidence.

## Alternatives considered

- A capped mainnet pilot. Even a low cap creates real-loss exposure before the
  required external review and sustained operating evidence exist.
- A local-chain-only demonstration. It is safer but does not prove public RPC,
  wallet, independent executor, confirmation, or recovery behavior.
- Demo fixtures only. They improve presentation reliability but cannot establish
  that either workflow settles on CKB.

## Consequences

- Testnet transaction hashes can support truthful end-to-end evidence without
  putting mainnet funds at risk.
- Network identity must be checked before construction, signing, and display.
- The product must avoid production-readiness, audit, yield, or guarantee claims.
- Testnet evidence does not establish mainnet security or economics.

## Reversal cost

Mainnet support requires a separate decision and release plan, independent
contract audit, remediation, sustained testnet and shadow evidence, deployment
governance, incident response, key controls, capacity and fee reassessment, and
owner migration and recovery procedures. This is a high-cost release boundary,
not a configuration toggle.
