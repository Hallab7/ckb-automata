# Job Identity V1

Every Job Cell carries a deterministic 32-byte `job_id`. It is derived from
creation evidence and policy commitments, never from an API or indexer record.

## Derivation

`job_id` is the protocol hash `H("ckb-automata/job-id/v1", body)`, where `H`
uses the framing and CKB-personalized blake2b-256 definition in the canonical
schema. The body is the following exact concatenation:

| Field                 | Encoding                          |
| --------------------- | --------------------------------- |
| Genesis hash          | 32 bytes                          |
| Protocol version      | unsigned 16-bit little-endian     |
| Creation commitment   | 32 bytes                          |
| Creation anchor tag   | `0` for output index, `1` Type ID |
| Creation anchor value | unsigned 64-bit index or 32 bytes |
| Creator nonce         | unsigned 64-bit little-endian     |
| Policy script hash    | 32 bytes                          |

The creation commitment is a hash of the normalized creation intent selected
by the transaction builder. The tagged anchor identifies the created cell by
either its output index in that committed transaction or a Type ID. The tag is
part of the hash input, so the two forms cannot alias each other.

Genesis hash prevents reuse across networks. Protocol version prevents a later
encoding from reusing a V1 identity. The creation anchor and nonce separate
otherwise identical jobs, while the policy hash makes a policy change produce
a distinct identity.

`contracts/fixtures/job_identity_v1.json` is the cross-language golden vector.
Both the TypeScript SDK helper and Rust contract helper must match it.
