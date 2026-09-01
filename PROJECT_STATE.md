# PROJECT STATE — NEXORA ISP OS

Live project status. Read this first when resuming work. Update after every checkpoint.

---

## CurrentObjectives

- **Stages 1–9 COMPLETE.** Primary E2E **27/27**, chaos/security E2E **15/15**, unit **151/151**.
- Remaining (ops/user-side only): Railway deploy of web+scheduler, SMS gateway creds, MikroTik hardware verification (KR-3), attach Postgres/Redis env vars (RAILWAY_SETUP.md).

## BuildOrder (from persona §6 — sequential, do not skip)

| # | Stage | Steps | Status |
|---|-------|-------|--------|
| 1 | Foundation | 1–5 scaffold/tooling/schema/migration/kernel | ✅ COMPLETE |
| 2 | Identity & Security | 6–8 auth, RBAC, audit | ✅ COMPLETE |
| 3 | Commerce | 9–13 customers, packages, billing, M-Pesa, subscriptions | ✅ COMPLETE |
| 4 | Network | 14–20 router registry, adapters, ops queue, policy engine, desired state | ✅ COMPLETE |
| 5 | Runtime & Control | 21–26 AAA, sessions, usage, FUP, expiry, reconciliation | ✅ COMPLETE |
| 6 | Event & Workflow | 27–30 outbox dispatcher, worker framework, event bus, orchestration | ✅ COMPLETE (ADR-011: Postgres transport) |
| 7 | API & Frontends | 31–35 API surface, webhooks, portals, admin command center | ✅ COMPLETE (Next.js portal + interim portal) |
| 8 | Operations & Hardening | 36–40 cron, health, observability, notifications, Railway config | ✅ CORE (SMS gateway + web-on-Railway pending) |
| 9 | Verification | 41–45 unit/integration/E2E/chaos/security tests | ✅ COMPLETE (unit 151 · e2e 27 · chaos/security 15) |
| 7 | API & Frontends | 31–35 API surface, webhooks, portals, admin command center | PENDING |
| 8 | Operations & Hardening | 36–40 cron, health, observability, notifications, Railway config | PENDING |
| 9 | Verification | 41–45 unit/integration/E2E/chaos/security tests | PENDING |

## CompletedModules

- Stage 1: monorepo, kernel, state machines, contracts, config, logging, events ports, RBAC matrix, router/payment SDKs, Prisma schema+migration+seed, Dockerfiles, railway.json, runbook
- Stage 2: Argon2id hasher, HMAC token service (revocable staff sessions), auth plugin (principal/requirePermission/audit), auth + customer endpoints, rate limits
- Stage 3: package catalog, payment initiate (idempotent), payment status, M-Pesa webhook atomic activation transaction (subscription+snapshot+FUP+desired state+network op+outbox+audit), Daraja + Mock providers
- Stage 4 core: Mock + MikroTik adapters, network-worker op executor (claim→execute→read-back verify→retry/permanent), admin op retry, policy resolver + FUP evaluator (pure)
- Stage 6 core: outbox dispatcher (worker), outbox writes at all mutations, SystemEvent trail
- Admin API: summary, customers, payments, network-operations, audit; RBAC enforced (E2E-verified 403)
- Interim NOC portal (dark, mono) served at :5000 — customer purchase flow + admin console
  - Stage 5 engines: usage (session auto-create, rollover-safe deltas, hourly aggregation), FUP (transitions + versioned desired-state + APPLY_POLICY/restore ops + admin reset), expiry (EXPIRED + revoke + DEAUTHORIZE + session termination + audit), reconciliation (drift→repair ops, synchronizedAt), router-health (status transitions + events)
- packages/engines workspace; scheduler enqueues 6 deduped Job types; worker/network-worker job runners partitioned DB-bound vs router-bound
- Admin: sessions list/disconnect, FUP reset (audited); customer /me with FUP usage
- `npm run e2e`: embedded PostgreSQL 17.5 + migrations + seed + 3 services + **25 acceptance checks**
- State machines (@nexora/domain): Customer, Subscription, Payment, NetworkOperation, Session, FUP — all with exhaustive unit tests
- Contracts (@nexora/contracts): event catalog (42 event types), API error envelope, health/pagination shapes
- Config (@nexora/config): zod env schemas + strict parseEnv (tested)
- Logging (@nexora/logging): pino wrapper, secret redaction, correlation binding
- Events (@nexora/events): outbox ports + OutboxCollector
- Auth (@nexora/auth): 7 roles, 30 permissions, full RBAC matrix (tested), PasswordHasher/TokenService ports
- Router SDK (@nexora/router-sdk): RouterAdapter port, capability model, canonical subscriber state types
- Payment SDK (@nexora/payment-sdk): PaymentProvider port, STK/query/callback types, Kenyan MSISDN normalization (tested)
- Prisma schema: 26 models, 30 enums, tenantId fields, outbox/event/job/audit tables — see packages/db/prisma/schema.prisma
- App shells: api (Fastify + /health/live + /health/ready + error envelope + graceful shutdown), worker/network-worker/scheduler (boot + DB ping + heartbeat + graceful shutdown), per-app Dockerfiles

## PendingModules

- Initial migration execution + seed run against a real database (BLOCKED by KR-1 — code-complete, idempotent)
- All Stage 2+ modules per BuildOrder (Stage 2 plan detailed in CHECKPOINT.md)

## Dependencies

- Runtime: fastify, prisma/@prisma/client, pino, zod
- Planned: bullmq+ioredis (Stage 6), @node-rs/argon2 (Stage 2), next (Stage 7)

## KnownRisks

- **KR-1 No local PostgreSQL — RESOLVED for migration generation**: initial migration created offline via `prisma migrate diff`; execution happens via the api service's Railway pre-deploy hook. Local integration testing still needs Docker Postgres when available (KR-2).
- **KR-2 No Docker / no git on dev workstation** — Dockerfiles/railway.json verified only by the live Railway build (which succeeded); version control must be initialized by the user (git not on PATH). Neither blocks code progress.
- **KR-3 Railway private network reachability to on-site MikroTik** — Pattern A vs Pattern B decision deferred to Stage 4 (see architecture map §42); adapter boundary keeps both open.

## ADRs

See docs/adrs/: ADR-001 npm workspaces, ADR-002 Fastify, ADR-003 schema location, ADR-004 source-path imports, ADR-005 esbuild bundling, ADR-006 Argon2id, ADR-007 integer money & BigInt bytes, ADR-008 router secret references, ADR-009 Vitest, ADR-010 pino.

## TechnicalDebt

See docs/technical-debt.md — TD-001 (web deps deferred), TD-002 (Docker runtime copies full node_modules), TD-003 (audit actor polymorphism unenforced FK).

## OutstandingQuestions

- None blocking. KR-3 (router connectivity pattern) resolves at Stage 4 with real router details.

## ValidationStatus

- [x] TypeScript strict typecheck — 13 workspaces, exit 0 (after Stage 2–4 code)
- [x] ESLint — exit 0
- [x] Vitest — **140/140** (8 files)
- [x] Bundles ×4 — build clean (argon2 external)
- [x] **`npm run e2e` — 25/25 PASS** (full control loop: purchase→authorize→usage session→FUP throttle (desired v2, verified op)→reconciliation synchronized→expiry deauth (verified)→customer-visible state; duplicate-callback no-op; RBAC 403)
- [x] Prisma schema valid + client generated + initial migration regenerated (Payment↔Package relation)
- [ ] Railway runtime green — awaiting user env vars (RAILWAY_SETUP.md)
- [x] npm audit reviewed — KR-6 accepted
