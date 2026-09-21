# Secret Handling

Automata never accepts or stores a user's private key, seed phrase, mnemonic,
wallet export, or unrestricted signing material. Browser wallets sign user
transactions locally. Known environment variables for user signing material
cause application startup to fail.

## Secret inventory

| Name                         | Owner            | Local source             | Preview and public source              |
| ---------------------------- | ---------------- | ------------------------ | -------------------------------------- |
| `AUTH_SESSION_SECRET`        | API              | Ignored `.env` file      | Deployment secret manager              |
| `WEBHOOK_ENCRYPTION_KEY`     | API              | Ignored `.env` file      | Deployment secret manager              |
| `EXECUTOR_FEE_PRIVATE_KEY`   | Executor         | Ignored `.env` file      | Isolated executor secret reference     |
| `NOTIFICATION_EMAIL_API_KEY` | API              | Disabled placeholder     | Notification provider secret reference |
| `ERROR_TRACKING_DSN`         | All services     | Disabled placeholder     | Observability secret reference         |
| `OTEL_EXPORTER_OTLP_HEADERS` | All services     | Disabled placeholder     | Observability secret reference         |
| `DATABASE_URL`               | API and executor | Local Compose connection | Database binding                       |
| `REDIS_URL`                  | API and executor | Local Compose connection | Redis binding                          |

[`config/.env.example`](../../config/.env.example) contains non-secret local
placeholders. Real local values belong in ignored `.env` files. Deployment
manifests must contain logical secret references, never secret values.

## Logging and repository checks

All structured application logs must pass through `redactLogRecord`. It removes
recognized secret keys, authorization data, cookies, signatures, wallet
material, and configured secret values even when they occur inside nested
objects, arrays, or free-form messages.

Run `pnpm secrets:check` before committing. CI runs the same high-confidence
scan for private-key blocks, common provider tokens, funded executor key values,
and configured user signing material.

## Rotation

1. Create a replacement value in the environment's secret manager.
2. Deploy dual-key verification where the secret's protocol permits it.
3. Restart a canary instance and verify authentication, webhooks, and logging.
4. Revoke the old value after active sessions and delivery retries expire.
5. Record the rotation date, owner, and affected deployment without recording
   either value.

Rotate immediately after suspected exposure. Rotate session and webhook secrets
at least every 90 days and executor fee keys at least every 30 days.

## Executor fee keys

Each executor instance uses a distinct testnet-only fee key. It must never be a
contract owner, recipient, reward beneficiary, deployment key, or personal
wallet key. Cap each key at the lower of 1,000 testnet CKB or one day of expected
fees, and refill it through a monitored operation. Alert when a balance exceeds
the cap, a transaction targets an unknown destination, or an outgoing
transaction cannot be linked to an executor job. Key rotation changes executor
identity metadata only and must not require user migration.
