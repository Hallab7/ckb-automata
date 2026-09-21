# Lower-Bound Trigger Validation

Job Cell execution uses the input's CKB `since` field as the consensus-enforced lower bound. The
Job Lock requires that value to exactly equal `JobDataV1.not_before`; an executor cannot replace the
committed value with an earlier bound.

## Supported Encodings

The proof of concept supports the absolute forms defined by
[CKB RFC 17](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0017-tx-valid-since/0017-tx-valid-since.md).

| Trigger kind | CKB metric bits | Meaning                                     |
| ------------ | --------------: | ------------------------------------------- |
| `1`          |            `00` | Absolute block number                       |
| `2`          |            `01` | Absolute epoch number with index and length |
| `3`          |            `10` | Absolute timestamp                          |
| `4` to `6`   |            `00` | Event-driven trigger; `since` must be zero  |

Bit 63 must be zero because relative lower bounds are not supported. Reserved bits 56 through 60
must also be zero, and metric bits `11` are invalid. For epoch values, `index` must be less than
`length`; the canonical zero fraction is also accepted as `index = 0, length = 0`.

## Enforcement Boundary

The Job Lock validates the encoding, trigger-to-metric match, and exact equality between the
committed and transaction values. CKB consensus evaluates whether the transaction's absolute
`since` value is mature at the current chain tip. The script does not accept caller-supplied tip or
timestamp data, so execution before the committed lower bound remains impossible without bypassing
consensus validation.

`not_after` is advisory metadata in this proof of concept. Upper-bound execution windows cannot be
expressed by CKB `since` and are not enforced by this rule. Relative `since` encodings are rejected
rather than interpreted.

## Verification Scope

Native vectors cover immediately before, exactly at, and immediately after the block, epoch, and
timestamp boundaries. Contract VM coverage proves that a transaction input whose `since` value does
not exactly match the committed lower bound is rejected with `InvalidSince` (`23`). These checks do
not claim a live-network submission; contextual maturity remains a CKB consensus check.
