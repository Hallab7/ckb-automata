# ADR 0001: Use a pnpm Monorepo

- Status: Accepted
- Date: 2026-09-21
- Scope: Showcase source layout and JavaScript dependency management

## Context

The web application, API, executor, TypeScript SDK, generated codecs, generated
API client, shared UI, configuration, and test fixtures change together. Their
contracts must remain synchronized while each application remains independently
buildable and deployable.

## Decision

Keep the showcase in one repository managed by a pinned pnpm workspace. Publish
internal boundaries as workspace packages and consume them by package name.
Applications must not reach into another package through source-path aliases.
Rust contracts remain Cargo workspace members in the same repository.

## Alternatives considered

- Separate repositories for every deployable and package. This improves access
  isolation but makes schema, SDK, and generated-client changes harder to land
  atomically.
- npm or Yarn workspaces. Both can model the graph, but pnpm provides strict
  dependency isolation and efficient deterministic installs for this project.
- One application package with local folders. This removes workspace setup but
  obscures deployable and ownership boundaries.

## Consequences

- A single revision identifies compatible applications, packages, contracts,
  schemas, and fixtures.
- CI can detect cross-layer drift before deployment.
- Workspace boundaries and dependency declarations must be enforced because a
  monorepo otherwise makes accidental coupling easy.
- Repository CI and checkout size grow as the product grows.

## Reversal cost

Splitting repositories requires publishing and versioning every shared package,
establishing release ordering, moving CI and issue ownership, and replacing
atomic changes with coordinated releases. The cost is high after generated
schemas and deployment manifests have consumers, so reversal should occur only
with an explicit release and compatibility plan.
