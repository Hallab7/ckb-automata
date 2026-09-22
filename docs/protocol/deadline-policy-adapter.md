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
```

The campaign type hash is unique because campaign creation derives its script
args from a one-use input outpoint and the campaign output index. The adapter
recomputes the payload from the live policy script and its args, locates exactly
one input with that type hash, and requires `policy_script_hash` to equal its
own script hash. Omitting the future campaign outpoint lets one transaction
create the campaign and its Job Cell without a circular transaction-hash
dependency.

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
- Mutation coverage: payload hash, policy hash, reward
  amount, Job Cell successor, and cross-wired terminal campaign identity.
- Local chain: not exercised in this implementation unit.
- Public testnet: not exercised or claimed in this implementation unit.
