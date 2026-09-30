# DAO Harvest Operations

DAO harvest automations keep the original deposit under the on-chain vault rules. The API,
database, Redis, and executors help with scheduling and display, but none of them is required for
the owner to stop or exit.

## Owner recovery

Use a fresh checkout, the published `ckb_testnet` harvest deployment artifact, a public CKB RPC,
the owner's lock script, and an owner-controlled live cell. The tool only creates an unsigned
transaction. Review it in the wallet before signing.

First identify the action without contacting a CKAutomata service:

```text
pnpm recovery harvest-plan --condition service_unavailable --vault-state deposited
pnpm recovery harvest-plan --condition deprecated --vault-state withdrawing --claim-mature
```

- `deposited`: use `owner-exit` to prepare the DAO withdrawal. Claim after the DAO maturity date.
- `withdrawing`, not mature: wait. An early claim is rejected locally and by the DAO script.
- `withdrawing`, mature: use `mature-recovery` to claim directly to the owner lock.
- `budget_exhausted`, `deprecated`, or `service_unavailable`: the same owner path remains valid.

Example mature claim export:

```text
pnpm recovery harvest-export \
  --harvest-deployment deploy/manifests/dao-harvest-testnet.json \
  --rpc-url https://testnet.ckb.dev \
  --owner-lock owner-lock.json \
  --owner-out-point OWNER_TX_HASH:0x0 \
  --vault-out-point VAULT_TX_HASH:0x0 \
  --operation mature-recovery \
  --deposit-header DEPOSIT_HEADER_HASH \
  --prepare-header PREPARE_HEADER_HASH \
  --vault-occupied-capacity OCCUPIED_SHANNONS \
  --claim-since ABSOLUTE_EPOCH_SINCE \
  --output unsigned-dao-recovery.json
```

The exporter verifies the network genesis, live owner and vault cells, committed owner, vault
scripts, withdrawing state, referenced-header DAO rates, and current public-chain maturity. It
refuses RPC URLs containing credentials and refuses to overwrite an existing output file. It never
accepts a private key.

## Operator controls

Pause one executor when chain evidence is uncertain. A pause rejects new work, returns HTTP 503
from `/health/ready`, and lets already-started work retain chain access so it can finish cleanly.
Resume only after comparing the public chain state with the committed intent. Keep the other
independent executor available unless the problem affects the scripts or network globally.

Inspect dead letters before replaying them:

```text
pnpm --filter @ckb-automata/executor dead-letter -- inspect DEAD_LETTER_ID --operator NAME
```

- RPC and temporary dependency failures may be replayed after the dependency recovers.
- Script, principal, payout, or intent failures require a pause and manual transaction comparison.
- Missed-window, retired-script, and exhausted-budget failures must not be replayed. Direct the
  owner to recovery instead.

Every terminal executor receipt is signed, explicitly non-authoritative, and binds the transaction,
job, sequence, executor identity, result, and DAO operation when present. Confirm chain inclusion
independently before treating a receipt as final.

## Incident runbooks

### Missed preparation window

1. Confirm the public tip is past the committed cutoff.
2. Do not submit a late preparation transaction.
3. Record `prepare_missed`; the principal remains deposited for the next DAO cycle.
4. Check executor readiness, queue age, RPC errors, and clock health before the next window.

### Reorganization

1. Pause the affected executor and verify the canonical headers through a second public RPC.
2. Check whether the original job and vault inputs are live.
3. Reconcile only from canonical cells. Never infer completion from a receipt or database row.
4. If inputs cannot be reconciled, mark recovery required and give the owner the independent path.

### RPC outage

1. Keep submission paused while genesis, tip, or live-cell reads are unavailable.
2. Do not switch networks or accept a mismatched genesis hash.
3. After recovery, verify tip progression and live inputs, then replay only retryable dead letters.

### Script deprecation

1. Pause every executor for the retired code hash and publish the affected deployment digest.
2. Do not replay pending work under a replacement script.
3. Notify owners to stop or exit with the published recovery artifact.
4. A replacement automation requires a new wallet review and signature.

## Alerts

The reference Prometheus rules are in `deploy/monitoring/dao-harvest-alerts.yml`. Alert labels are
bounded and contain no addresses, transaction hashes, job IDs, or RPC URLs. Notifications use the
existing `ready`, `confirmed`, `failed`, `budget_low`, and `recovery_required` preferences.

Owner recovery is deliberately independent of CKAutomata's API, Redis, database, executors, and
operator cooperation. If those services are all offline, use public CKB data and the owner's wallet.
