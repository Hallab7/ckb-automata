# Public Data Services

The public showcase API runs as `ckb-automata-api` on Render. It uses the
externally managed Aiven PostgreSQL database and the private
`ckb-automata-redis` Render Key Value instance. Secret values are configured in
Render and never stored in `render.yaml` or deployment logs.

## Deployment controls

- The API is built from the repository root with the pinned Node and pnpm
  versions.
- Automatic deploys are disabled. Operators deploy an audited commit explicitly.
- `DATABASE_URL` uses PostgreSQL TLS with `sslmode=require`.
- Redis has no public IP allowlist and uses `noeviction`, which is required for
  BullMQ correctness.
- The free showcase Redis tier does not persist data to disk. Pending work must
  be reconstructed from PostgreSQL and canonical CKB state after a datastore
  replacement. Upgrade to the `256mb` plan with `journal_snapshot` before any
  availability claim beyond the showcase.
- Render terminates TLS and probes `/v1/health/live`. The application readiness
  endpoint separately checks PostgreSQL, Redis, CKB RPC, the deployment
  manifest, and indexer lag.

Apply schema migrations as an explicit job before each API deployment:

```text
render jobs create <service-id> --start-command "pnpm database:migrate"
render deploys create <service-id> --commit <revision> --wait
```

Verify the live service without printing any configured secret:

```text
PUBLIC_API_URL=https://<service>.onrender.com/ \
PUBLIC_APP_ORIGIN=https://ckb-automata.vercel.app \
pnpm deploy:verify:public-api
```

## Backup and restore

Aiven is the system of record for database backups. Before migrations, create a
logical backup with `pg_dump --format=custom --no-owner --no-acl`. Store it in
an access-controlled backup location, record its SHA-256 digest, and never add
the dump to this repository.

Test restoration into an isolated database, never over `defaultdb`:

```text
createdb <temporary-restore-database>
pg_restore --exit-on-error --no-owner --no-acl --dbname=<temporary-restore-url> <backup-file>
psql <temporary-restore-url> -c "SELECT version, checksum FROM automata_schema_migrations ORDER BY version"
dropdb <temporary-restore-database>
```

The restore is accepted only when migration checksums match the repository and
row counts for networks, script deployments, jobs, job versions, events,
attempts, checkpoints, webhook registrations, and webhook deliveries match the
backup record.

## Operations

Render retains structured stdout/stderr logs and sends default deploy-failure
notifications. `/v1/metrics` exposes Prometheus metrics; `/v1/health/ready`
drives dependency alerts. Alert when readiness remains unavailable for five
minutes, index lag exceeds five blocks for five minutes, or queue age exceeds
the documented service objective.

For a dependency drill, suspend only the test resource under review, confirm
`/v1/health/ready` returns `503` while `/v1/health/live` remains `200`, restore
the dependency, and confirm the full live verifier passes. Do not run failure
drills against the public showcase while a user transaction is in progress.
