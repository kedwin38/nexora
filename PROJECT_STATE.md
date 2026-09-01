# PROJECT STATE — NEXORA ISP OS

Live project status. Read this first when resuming work. Update after every checkpoint.

---

## CurrentObjectives

- Stage 1 (Foundation): **COMPLETE** (migration execution deferred to Railway staging per KR-1).
- Stage 2 (Identity & Security): Argon2id auth, session tokens, RBAC middleware, audit framework — see CHECKPOINT.md "Next".

## BuildOrder (from persona §6 — sequential, do not skip)

| # | Stage | Steps | Status |
|---|-------|-------|--------|
| 1 | Foundation | 1–5 scaffold/tooling/schema/migration/kernel | ✅ COMPLETE (migration exec deferred to staging, KR-1) |
| 2 | Identity & Security | 6–8 auth, RBAC, audit | NEXT |
| 3 | Commerce | 9–13 customers, packages, billing, M-Pesa, subscriptions | PENDING |
| 4 | Network | 14–20 router registry, adapters, ops queue, policy engine, desired state | PENDING |
| 5 | Runtime & Control | 21–26 AAA, sessions, usage, FUP, expiry, reconciliation | PENDING |
| 6 | Event & Workflow | 27–30 outbox dispatcher, worker framework, event bus, orchestration | PENDING |
| 7 | API & Frontends | 31–35 API surface, webhooks, portals, admin command center | PENDING |
| 8 | Operations & Hardening | 36–40 cron, health, observability, notifications, Railway config | PENDING |
| 9 | Verification | 41–45 unit/integration/E2E/chaos/security tests | PENDING |

## CompletedModules

- Monorepo scaffold: apps/{api,worker,network-worker,scheduler,web}, packages/{domain,contracts,config,logging,events,auth,db,router-sdk,payment-sdk}
- Root tooling: TypeScript strict (NodeNext), ESLint 9 flat config, Prettier, Vitest, npm workspaces
- Shared kernel (@nexora/domain): branded IDs, Result, NexoraError taxonomy, event envelope, correlation IDs
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

- **KR-1 No local PostgreSQL** — `prisma migrate dev` cannot run on this workstation. Mitigation: schema validated via `prisma validate`; generate via `prisma generate`; first real migration executes against Railway staging during Stage 2/deploy. Local integration tests will use an ephemeral Postgres when Docker is available (KR-2).
- **KR-2 No Docker / no git on dev workstation** — Dockerfiles untested locally; version control must be initialized by the user (git not on PATH). Neither blocks code progress.
- **KR-3 Railway private network reachability to on-site MikroTik** — Pattern A vs Pattern B decision deferred to Stage 4 (see architecture map §42); adapter boundary keeps both open.

## ADRs

See docs/adrs/: ADR-001 npm workspaces, ADR-002 Fastify, ADR-003 schema location, ADR-004 source-path imports, ADR-005 esbuild bundling, ADR-006 Argon2id, ADR-007 integer money & BigInt bytes, ADR-008 router secret references, ADR-009 Vitest, ADR-010 pino.

## TechnicalDebt

See docs/technical-debt.md — TD-001 (web deps deferred), TD-002 (Docker runtime copies full node_modules), TD-003 (audit actor polymorphism unenforced FK).

## OutstandingQuestions

- None blocking. KR-3 (router connectivity pattern) resolves at Stage 4 with real router details.

## ValidationStatus

- [x] `npm install` — 333 packages (6m)
- [x] Prisma schema valid (`prisma validate`) — "schema is valid 🚀"
- [x] `prisma generate` — Prisma Client v6.19.3
- [x] TypeScript strict typecheck passes — all 13 workspaces, exit 0
- [x] ESLint passes — exit 0
- [x] Vitest suite green — 108/108 tests, 4 files
- [x] esbuild bundles build — 4 apps (api 2.0MB, others ~263KB, `.cjs` format per ADR-005)
- [x] API boot smoke test — `/health/live` 200; `/health/ready` 503 degraded with postgres:down (correct, no local DB); 404 returns structured error envelope with correlationId
- [ ] Initial migration — blocked by KR-1 (executes against Railway staging)
- [x] npm audit reviewed — KR-6 accepted (prisma CLI dev-only transitive advisory)
