# ADR 0005: Use Redis and BullMQ for Durable Work

- Status: Accepted
- Date: 2026-09-21
- Scope: Background work coordination

## Context

Discovery, eligibility checks, transaction construction, submission,
confirmation, notifications, retries, and dead-letter handling outlive a single
process. Queue delivery is at least once, while CKB cell consumption and the
database projection require idempotent handling.

## Decision

Use Redis and BullMQ through `@nestjs/bullmq`. Define durable queues with stable
job identifiers, bounded retries, explicit retention, and dead-letter handling.
Treat scheduled queue times only as wake-up hints; current CKB state and contract
rules determine eligibility.

## Alternatives considered

- In-memory queues and timers. They lose work during restart and cannot
  coordinate independent executor instances.
- PostgreSQL-backed polling. This reduces infrastructure but adds queue locking,
  retry, scheduling, and observability behavior the team would have to build.
- A hosted message broker such as Kafka or RabbitMQ. Both are capable but add
  operational complexity beyond the showcase's work volume and routing needs.

## Consequences

- Pending work survives application restarts and can be inspected separately
  from process memory.
- Every handler must be idempotent and safe under duplicate delivery.
- Redis becomes an availability dependency, but never a source of protocol
  truth.
- Queue health, age, depth, retry counts, and dead letters require monitoring.

## Reversal cost

Changing queue technology requires migrating job identifiers, payload schemas,
retry classification, scheduling, retention, metrics, and operational tooling.
The cost is medium to high. Removing durable work entirely would violate the
restart and independent-executor requirements.
