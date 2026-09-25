# Executor Operations

The public showcase runs `operator-a` and `operator-b` as independent Render services. Each
instance supports the deadline and recurring adapters, uses independently namespaced durable
queues on the shared Redis service, and has a distinct testnet-only secp256k1 fee key.

| Instance     | Render service             | Testnet fee address                              |
| ------------ | -------------------------- | ------------------------------------------------ |
| `operator-a` | `srv-dar3cbbncjis73bvg600` | `ckt1qyqvaw3x5ps8lvdteh0p5txgxr3aurxds0tqvc9pr4` |
| `operator-b` | `srv-dar3cip7lnhs739suq2g` | `ckt1qyqpthft24t5t4yq46p0k5mwag82fuew8d9stkugjc` |

Each instance derives its own Redis queue namespace from `EXECUTOR_INSTANCE_ID`. Both operators
therefore observe eligible jobs independently; PostgreSQL claim guards and CKB input contention
select one canonical winner without making either process a prerequisite for the other.

## Wallet limits

- Fund each operator with 500 testnet CKB and never exceed the 1,000 CKB hard cap.
- Never reuse an owner, recipient, refund, deployment, or personal wallet key.
- Alert on an unknown destination, an unlinked outgoing transaction, or a balance above the cap.
- Keep `EXECUTOR_FEE_PRIVATE_KEY` only in the service secret manager. Its matching public lock args
  belong in `EXECUTOR_LOCK_ARGS`.

## Health and isolation

`GET /health/live` proves that the process can answer HTTP. `GET /health/ready` additionally reports
the instance identity, supported adapters, chain identity, Redis readiness, and active work. Pause
one service at a time and confirm the other remains ready before maintenance.

The showcase currently uses Render Free web instances by explicit operator choice. Render may stop
or restart a Free instance, and an idle instance stops after 15 minutes without inbound traffic.
The `Public Runtime` GitHub workflow probes the API and both executors every 10 minutes to reduce
idle stops and retain failure evidence. This is a showcase workaround, not an uptime guarantee or a
replacement for always-on worker compute. A delayed GitHub schedule can still allow a cold start.

Run the same identity-bound check manually with:

```text
PUBLIC_API_URL=https://ckb-automata-api.onrender.com/ \
EXECUTOR_A_URL=https://ckb-automata-executor-a.onrender.com/ \
EXECUTOR_B_URL=https://ckb-automata-executor-b.onrender.com/ \
pnpm deploy:verify:public-runtime
```

## Rotation

1. Generate a new testnet-only key without printing it to logs or shell history.
2. Derive its lock args and fund the new address with no more than 500 testnet CKB.
3. Replace `EXECUTOR_FEE_PRIVATE_KEY` and `EXECUTOR_LOCK_ARGS` on one service only.
4. Deploy that service and require its ready endpoint to report the expected instance and adapters.
5. Run one eligible test job, confirm its receipt key identity, then rotate the second service.
6. Recover or transfer the old fee cells, revoke the old secret, and record the date and operator.

Never rotate both operators simultaneously. A key change affects only executor-owned fee cells and
receipt identity; it does not require user jobs or owner wallets to migrate.
