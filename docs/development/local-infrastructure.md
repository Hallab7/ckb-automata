# Local Infrastructure

PostgreSQL and Redis run through Docker Compose. No global database or cache
installation is required.

Start both services and wait for their health checks:

```text
npx --yes pnpm@12.5.1 infra:up
npx --yes pnpm@12.5.1 infra:health
```

The defaults bind PostgreSQL to `127.0.0.1:55432` and Redis to
`127.0.0.1:56379`. They avoid the conventional ports so Automata does not
interfere with existing local projects. Override `POSTGRES_PORT` or `REDIS_PORT`
when needed. `deploy/docker/.env.example` contains only local, non-secret sample
values.

Data persists in the named `ckb-automata-postgres-data` and
`ckb-automata-redis-data` volumes. Stop containers without deleting data:

```text
npx --yes pnpm@12.5.1 infra:down
```

Volume removal is intentionally not part of a root command. Production and
public testnet services must not reuse these local credentials or volumes.
