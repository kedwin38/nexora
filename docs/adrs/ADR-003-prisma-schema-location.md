# ADR-003: Prisma schema lives in packages/db

## Decision
`packages/db/prisma/schema.prisma` (owned by `@nexora/db`), not a root-level `prisma/` directory.

## Reason
- The schema, generated client, migrations and seed form one deployable unit imported by every service — a workspace package is the natural boundary (§70-71: "packages/db").
- Root scripts (`npm run db:*`) still expose one-command access for humans and Railway pre-deploy hooks.

## Tradeoffs
- Deviates from the architecture map's illustrative root `prisma/` folder listing; documented here as an intentional refinement, not a contradiction.

## Alternatives Considered
1. Root `prisma/` — matches doc diagram; splits schema ownership from the package that consumes it.

## Status
Accepted (2026-09-01)
