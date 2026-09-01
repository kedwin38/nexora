# ADR-002: Fastify for the API service

## Decision
Implement `apps/api` with Fastify 5, not Express.

## Reason
- First-class TypeScript + JSON-schema validation hooks.
- Built-in request IDs (`genReqId`) — correlation IDs for free (§50).
- Lifecycle hooks (`onClose`) map cleanly to graceful shutdown of Prisma/Redis.
- Higher throughput with lower allocations than Express 4/5 at equal correctness.

## Tradeoffs
- Team familiarity in the legacy codebase was Express; Fastify's plugin model has a learning curve.
- Middleware ecosystem is smaller, but this system needs few generic middlewares (auth/RBAC are plugins).

## Alternatives Considered
1. Express 5 — maximum familiarity (legacy repo uses Express 4); weaker typing, manual request-ID plumbing.
2. Fastify vs NestJS — NestJS adds a DI framework + decorators we don't need at this scale of modular monolith.

## Status
Accepted (2026-09-01)
