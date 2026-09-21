# Contract Fixture Builders

`src/fixtures.rs` owns shared `ckb-testtool` construction for contract tests. It
provides seeded scripts, owner locks, executor identities, witness arguments,
headers, occupied-capacity calculation, and live cells with explicit seeded
outpoints.

Tests must use these helpers instead of duplicating transaction setup. Any
helper that creates an identifier takes deterministic input; do not call
`Context::create_cell`, which assigns a thread-random outpoint.

`golden_transaction` exercises every helper in one serialized transaction. The
native suite constructs it in two independent contexts, compares all bytes, and
checks the committed transaction hash. Intentional fixture changes must update
the hash only after reviewing the serialized inputs, outputs, header dependency,
and witness.
