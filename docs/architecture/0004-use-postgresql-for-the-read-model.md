# ADR 0004: Use PostgreSQL for the Read Model

- Status: Accepted
- Date: 2026-09-21
- Scope: Indexed chain data and application persistence

## Context

The product needs durable, queryable projections for jobs, cell versions,
events, attempts, checkpoints, notification preferences, webhooks, and delivery
history. The database is a convenience index; CKB remains authoritative, and
the projection must be rebuildable from canonical chain data.

## Decision

Use PostgreSQL with Drizzle ORM and explicit SQL migrations. Store source
outpoints, block hashes, block numbers, and network identity with derived data.
Apply reorg rollback and replay transactionally. Application startup must never
silently mutate the schema outside the migration runner.

## Alternatives considered

- SQLite. It is easy to run locally but has weaker concurrent service and
  operational characteristics for the public API, indexer, and executor.
- A document database. Flexible documents do not outweigh the need for
  relational constraints, joins, transactions, and stable event ordering.
- Chain-only reads with no database. This avoids projections but makes filtered
  history, replay, preferences, and operational timelines impractical.

## Consequences

- Relational constraints and transactions protect projection consistency.
- Local development needs a PostgreSQL service, supplied through Docker Compose.
- Migrations, backups, retention, and restore drills become release artifacts.
- Database contents never substitute for script or canonical-chain evidence.

## Reversal cost

Changing databases requires translating migrations, constraints, pagination,
checkpoint and rollback transactions, operational procedures, and historical
data. The cost is high after public indexing begins. Replacing Drizzle while
retaining PostgreSQL is a medium-cost repository and query migration.
