# Error Code Registry

[`packages/core/src/errors.ts`](../../packages/core/src/errors.ts) is the
authoritative registry for stable diagnostic keys, numeric codes, domains, and
plain-language copy. On-chain exit values are mirrored by
[`contracts/shared/error_codes.rs`](../../contracts/shared/error_codes.rs) and
tested for exact parity.

| Domain   | Numeric range | Intended consumer                                             |
| -------- | ------------: | ------------------------------------------------------------- |
| Script   |         10-99 | CKB script exit values and transaction diagnostics            |
| SDK      |     1000-1099 | Decoding, manifest, network, intent, and wallet clients       |
| API      |     2000-2099 | HTTP and streaming error envelopes                            |
| Executor |     3000-3099 | Evaluation, simulation, submission, and confirmation attempts |

Every public error envelope carries the symbolic key, numeric code, and catalog
copy. Additional technical context may identify a field, outpoint, transaction,
or retry time, but it must not replace or redefine the stable diagnostic.

Script errors describe consensus-invalid transitions. SDK and API errors stop an
unsafe request before signing where possible. Executor failures describe an
attempt outcome and do not claim that a transaction was committed or confirmed.
Retry classification is defined separately from these stable identities.

New entries must use the next free value in their domain. Existing values and
meanings are never reused; a retired diagnostic remains reserved. CI rejects
duplicate values, missing user copy, incomplete planned failures, unmapped
invalid transitions, and Rust/TypeScript script drift.
