# ADR-011: PostgreSQL-backed queue transport for Phase 1

## Decision
Use the existing Postgres `Job` / `OutboxEvent` tables as the Phase 1 job and
event transport. BullMQ/Redis is deferred until horizontal scale requires it.

## Reason
- The architecture map mandates durable, retryable, at-least-once background
  processing with idempotent consumers — NOT a specific broker. Postgres
  gives all of those properties (atomic `UPDATE ... WHERE status=QUEUED`
  claiming, `runAfter` scheduling, bounded retries, visibility via SQL).
- One fewer runtime dependency (Redis becomes cache/rate-limit only), one
  transactional consistency domain: business mutations, outbox events and job
  claims commit together.
- Phase 1 runs single-instance workers per partition (DB-bound vs
  router-bound); contention is negligible.

## Tradeoffs
- Polling intervals (2–3s) instead of push → slightly higher latency.
- Queue depth competes with OLTP load on the same database.

## Alternatives Considered
1. BullMQ on Redis now — added infra + dual-store consistency for zero
   functional gain at current scale; revisit when worker replicas > 1 per
   partition or sub-second dispatch latency is required.
2. LISTEN/NOTIFY push — nice latency win later; keeps Postgres as the broker.

## Status
Accepted (2026-09-01) — supersedes TD-005 (debt → decision).
