# ADR 0002: Keep CCC Wallet Code in the Browser

- Status: Accepted
- Date: 2026-09-21
- Scope: Next.js, CCC, transaction review, signing, and submission

## Context

CKB Automata is non-custodial. The application may construct unsigned
transactions and quotes, but it must not receive a user's seed phrase, private
key, wallet export, or unrestricted signature. Next.js App Router also separates
Server Components from browser-only wallet APIs and React context.

## Decision

Use Next.js App Router for the web application and isolate
`@ckb-ccc/connector-react` behind a dedicated client component. The API returns
quotes and unsigned transaction skeletons. The browser completes owner inputs,
fee, and change, reconstructs and compares the policy intent, displays the exact
completed transaction, then asks the CCC signer to sign locally. Server
Components must not import wallet code.

## Alternatives considered

- Server-side wallet or hosted signing. This simplifies scheduled submission but
  makes the service custodial or grants authority broader than the job policy.
- A fully client-side application without an API. This preserves custody but
  duplicates indexing, quote, and construction logic and weakens operational
  observability.
- Pre-signing future transactions. Future headers and live cell inputs are not
  always known, and stale or malleable transactions create unsafe review gaps.

## Consequences

- User signing authority stays inside the selected wallet.
- Every transaction must pass a fresh browser-side intent comparison before the
  wallet opens.
- Wallet connection, rejection, network mismatch, stale quote, and stale input
  become explicit user-interface states.
- Browser-only integration needs client boundaries and cannot be exercised by
  server rendering alone.

## Reversal cost

Moving signing to a server would require a new custody and key-management threat
model, security review, user consent model, incident controls, and substantial
contract and product changes. Replacing CCC on the client is a medium-cost
adapter migration if the transaction-intent boundary remains stable.
