# ADR 0003: Separate the NestJS API and Executor

- Status: Accepted
- Date: 2026-09-21
- Scope: Backend process boundaries

## Context

Public reads and unsigned transaction construction have different availability,
security, scaling, and failure characteristics from chain discovery, dry runs,
fee-funded submissions, and confirmation tracking. Executor work must survive
HTTP process restarts and must not delay request handling.

## Decision

Use NestJS for shared configuration and module conventions, but deploy two
independent processes: an HTTP API and a standalone executor application
context with no public listener. The API publishes durable work; the executor
performs chain actions. Shared behavior lives in workspace packages rather than
through in-process calls.

## Alternatives considered

- One NestJS process for HTTP and execution. It is simpler to bootstrap but
  couples public traffic, deploys, crashes, and resource use to chain work.
- Serverless functions for all backend behavior. Request handlers suit reads but
  are a poor fit for durable queues, confirmations, and graceful job shutdown.
- A separate Rust executor service. This could reduce language diversity near
  CKB tooling, but would duplicate application configuration and queue contracts
  during the showcase.

## Consequences

- API and executor instances can scale, restart, and be paused independently.
- No HTTP request is the sole record of pending execution.
- Shared DTOs, adapters, telemetry, and configuration require stable package
  contracts.
- Deployment and local development must operate two processes and observe work
  across their boundary.

## Reversal cost

Combining the processes is mechanically moderate but operationally expensive:
queue ownership, shutdown behavior, health semantics, deployment topology, and
failure isolation would all change. Moving the executor to another language is
high cost once adapters and telemetry are implemented.
