# Deadline Policy Adapter

The deadline policy is the Job Cell type script for the demo campaign action.
Its 32-byte script args are the full type-script hash of the one campaign it
may finalize. The Job Lock and policy adapter both run in the finalization
transaction and enforce separate parts of the same committed intent.

## Payload Commitment

`JobDataV1.payload_hash` uses the schema's policy-payload domain and commits to
this canonical body:

```text
policy_script_hash     32 bytes
adapter_version         1 byte, value 1
campaign_type_hash     32 bytes
campaign_outpoint      36 bytes, canonical packed OutPoint
```

The exact input outpoint prevents a job from being executed against another
cell carrying an otherwise identical campaign type script. The adapter
recomputes the hash from the live policy script, its args, and the located
campaign input. It also requires `policy_script_hash` to equal its own script
hash.

## Atomic Validation

The adapter accepts only a live V1, absolute-block, one-shot job with no upper
bound. Its `not_before` value must equal the campaign deadline. It parses the
same execution witness as the Job Lock and independently checks the exact
plain reward output against the committed amount and executor lock hash.

Exactly one terminal output must carry the committed campaign type hash and
the objectively derived state marker. The adapter also rejects any output
using the consumed Job Cell lock, while the Job Lock independently rejects a
one-shot successor and enforces reward and capacity conservation. The campaign
type script remains authoritative for terminal data continuity and the exact
success or refund value path.

## Verification Status

- Fixture-backed CKB-VM: success and refund transactions pass with the Job
  Lock, deadline adapter, and campaign type script together.
- Mutation coverage: payload hash, campaign outpoint, policy hash, reward
  amount, Job Cell successor, and cross-wired terminal campaign identity.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
