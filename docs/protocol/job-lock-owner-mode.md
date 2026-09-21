# Job Lock Owner Mode

Job Lock V1 reserves two one-byte witness modes in the first group input's
`input_type` field:

| Value | Operation |
| ----- | --------- |
| `1`   | Cancel    |
| `2`   | Recover   |

Both modes are owner-authorized exits. Executor execution is intentionally not
accepted by this contract version.

## Authorization

The transaction must co-spend a distinct normal wallet input whose complete
lock-script hash equals the Job Cell's `cancel_lock_hash`. Comparing the full
hash commits the code hash, hash type, and arguments. The matching wallet lock
script runs as its own CKB lock group and is responsible for signature
validation; the Job Lock does not inspect or reproduce wallet signatures.

The owner authorization input cannot be another input in the Job Lock group,
and the committed owner hash cannot equal the active Job Lock hash.

## Refund

Owner mode accepts exactly one Job Cell in the active lock group. Output zero is
the refund and must have all of the following properties:

- capacity exactly equal to the consumed Job Cell capacity;
- lock hash equal to `cancel_lock_hash`;
- no type script; and
- empty cell data.

The co-spent wallet input pays transaction fees and may receive separate change.
This keeps the Job Cell refund independently reconstructible without an API,
database, queue, or hosted frontend.

## Verification status

- Fixture-backed CKB-VM: verified with the compiled Job Lock and bundled
  secp256k1 wallet lock for valid cancellation, standalone recovery, wrong
  owner, missing owner input, invalid signature, altered refund, and unsupported
  mode.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
