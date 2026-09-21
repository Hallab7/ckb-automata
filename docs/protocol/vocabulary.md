# Shared Protocol Vocabulary

These terms are normative across user copy, API values, executor logs, and
contract documentation. Product surfaces may explain a term in more detail but
must not change its meaning.

| Canonical term | UI wording      | API or worker name | Contract meaning                                                                                  |
| -------------- | --------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `job`          | Job             | `job`              | A funded cell carrying one automation intent and its policy commitment.                           |
| `policy`       | Policy          | `policy`           | The type script and committed rules that authorize a transition and constrain outputs.            |
| `trigger`      | Eligibility     | `trigger`          | Chain-observable evidence checked by policy; wall-clock or queue timing is never proof.           |
| `action`       | Action          | `action`           | A transaction transition that consumes the live job after scripts authorize it.                   |
| `successor`    | Next job        | `successor`        | The single constrained job output created for the next recurring run.                             |
| `reward`       | Executor reward | `reward`           | The committed amount paid atomically to the executor selected by the transaction.                 |
| `cancellation` | Cancel          | `cancellation`     | An owner-authorized normal close of a supported live job, with no executor reward.                |
| `recovery`     | Recover         | `recovery`         | An owner-authorized escape from an unsupported, invalid, or stalled job, with no executor reward. |
| `submitted`    | Submitted       | `submitted`        | No contract state exists yet; a node has only accepted the transaction for processing.            |
| `committed`    | Committed       | `committed`        | The scripts accepted the transition in a block on the currently canonical chain.                  |
| `confirmed`    | Confirmed       | `confirmed`        | Off-chain confidence after configured canonical depth; this is never a contract state.            |

## Status language

`scheduled` is not a job or transaction state. Use "future-eligible job" for a
job whose lower bound has not arrived, and state the actual transaction status
separately.

`executed` is not a confidence state. Name the action and its observed state,
such as "distribution committed" or "refund confirmed."

`confirmed` is reserved for a committed transaction at or beyond the configured
canonical depth. Inclusion in a block is only `committed`; RPC acceptance is
only `submitted`. A reorganization removes those claims until the transaction
is observed again on the canonical chain.
