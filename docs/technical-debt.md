# Technical Debt Register

Every entry: impact + remediation plan + trigger.

---

## TD-001: `apps/web` — RESOLVED (Next.js portal built, Stage 7)

- Next.js 15 App Router portal live (`apps/web`): staff/customer login, customer dashboard (FUP usage, live poll), package purchase with STK polling, 5-tab admin console. Interim single-file portal still served by the API at :5000 (kept for zero-dependency access; retire when web is deployed to Railway).

## TD-002: Docker runtime stage copies full node_modules

- **Impact:** larger images than strictly needed (only `@prisma/client` + engine are required external to the bundle).
- **Remediation:** prune to `node_modules/@prisma`, `node_modules/.prisma` once bundle-only runtime is proven in CI.
- **Trigger:** first Railway image-size review.

## TD-003: AuditLog actor polymorphism not FK-enforced

- **Impact:** `actorId` may reference User or Customer depending on `actorType`; Postgres cannot enforce both.
- **Why accepted:** append-only audit semantics + typed writer layer prevent orphans; FKs would forbid system/worker actors entirely.
- **Remediation (optional later):** split into `AuditActorUser` / `AuditActorCustomer` join tables or a polymorphic FK trigger.
- **Trigger:** first audit-integrity report request.

## TD-004: Customer tokens are stateless (not revocable server-side)

- **Impact:** A leaked customer token is valid until expiry (default 24h); staff tokens ARE revocable via UserSession.
- **Why accepted:** customers hold no privileges beyond their own data; adding a CustomerSession store is pure schema work.
- **Remediation:** reuse UserSession pattern with a dedicated AuthSession table + migration.
- **Trigger:** before public production launch or short token TTL requirement.

## TD-005: ~~Outbox dispatch is in-process~~ — RESOLVED as decision (ADR-011)

- Postgres-backed queue transport accepted for Phase 1 (atomic claims, scheduling, retries, SQL visibility); BullMQ deferred until worker replicas require it.

## TD-006: node-routeros is discontinued upstream

- **Impact:** Supply/compat risk for the MikroTik API transport.
- **Why accepted:** small, stable wire protocol; adapter confines all usage; mock adapter decouples tests.
- **Remediation:** migrate transport to `routeros-client` or a thin self-maintained API-protocol client when hardware verification happens (KR-3).
- **Trigger:** KR-3 hardware verification or first upstream breakage.

