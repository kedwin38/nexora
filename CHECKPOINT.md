# CHECKPOINT — Stage 1: Foundation

**Date:** 2026-09-01 · **Stage:** 1 (Foundation) · **Status: COMPLETE (one environment-blocked item)**

## What Was Built

- **Monorepo** (`nexora/`): npm workspaces — `apps/{api,worker,network-worker,scheduler,web}` + `packages/{domain,contracts,config,logging,events,auth,db,router-sdk,payment-sdk}` (ADR-001, ADR-003).
- **Tooling:** TypeScript 5.7 strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`), ESLint 9 flat config, Prettier, Vitest 3, per-app Dockerfiles (multi-stage, non-root, api has HEALTHCHECK).
- **Shared kernel** (`@nexora/domain`): branded IDs (12 entity types), `Result<T,E>`, `NexoraError` taxonomy (9 domain errors with code/retryable/correlationId), event envelope with correlation/causation.
- **State machines** (persona §2.D): Customer, Subscription, Payment, NetworkOperation, Session, FUP — invalid transitions throw `InvalidStateTransitionError`; FUP identified and documented as cyclic-by-design.
- **Contracts:** 42-event catalog, API error envelope, health/pagination wire types.
- **RBAC** (`@nexora/auth`): 7 roles × 30 permissions matrix + PasswordHasher/TokenService ports (Argon2id per ADR-006).
- **Ports:** `RouterAdapter` (11 methods + 8 capabilities + canonical subscriber state), `PaymentProvider` (STK/query/callback + Kenyan MSISDN normalization).
- **Prisma schema:** 26 models, 30 enums, tenantId on tenant-owned entities, outbox/event-log/job/audit/notification tables, `UNIQUE(provider, providerTransactionId)` payment idempotency, immutable subscription policy snapshots. Seed script: RBAC matrix, super-admin (env creds, Argon2id), 3 packages+policies, test router (ADR-008 secret reference).
- **API shell:** Fastify 5, `/health/live`, `/health/ready` (dependency probes), structured error envelope with correlation IDs, request logging (redacted), graceful SIGTERM/SIGINT.

## What Was Verified (commands + outcomes)

| Gate | Command | Result |
|------|---------|--------|
| Schema validity | `prisma validate` | ✅ "The schema at prisma\schema.prisma is valid" |
| Client generation | `prisma generate` | ✅ Generated Prisma Client v6.19.3 |
| Typecheck (13 workspaces) | `npm run typecheck` | ✅ exit 0, strict mode |
| Lint | `npm run lint` | ✅ exit 0 |
| Unit tests | `npm test` | ✅ 4 files, **108/108 passed** (state machines full valid/invalid coverage, RBAC integrity, env parsing, MSISDN) |
| Bundles | `npm run build` ×4 apps | ✅ api 2.0MB, worker/network-worker/scheduler ~263KB each |
| Boot smoke | `node dist/index.cjs` + curl | ✅ `/health/live` → 200 ok; `/health/ready` → 503 degraded (postgres:down — correct, no local DB); unknown route → 404 structured envelope with correlationId |

**Defects found & fixed during verification** (Layer 10 failure protocol):
1. Prisma relation errors (Customer.auditLogs polymorphic back-ref; Device↔CustomerSession) → schema corrected, TD-003 documents the polymorphic-actor design.
2. `noUncheckedIndexedAccess` caught unsafe test index access → fixed via `allowedFrom()`.
3. Test caught real bug: MSISDN normalizer accepted invalid `2548…` prefix → now validates canonical form before returning.
4. ESM bundle broke Fastify CJS internals → switched to `.cjs` bundles (ADR-005 updated).
5. Final certification run caught a union-of-generics type error in the new lifecycle-machines test (params collapsed to `never`) → widened to `StateMachine<string>[]`. All gates re-run green.

## Not Verified / Blocked

- **Initial migration + seed run** — no local PostgreSQL (KR-1). Migration executes against Railway staging at Stage 2 kickoff (`prisma migrate dev` with staging shadow DB or `migrate deploy` on first env). Seed is code-complete and idempotent.

## Next (Stage 2 — Identity & Security)

1. Argon2id `PasswordHasher` implementation + tests.
2. Token service (session tokens + UserSession table revocation), login/logout/register endpoints.
3. RBAC enforcement plugin (Fastify `requirePermission` decorator), rate limiting via Redis.
4. Audit writer (append-only, before/after state, correlation IDs) + admin credential bootstrap via seed.

## Blockers

- None code-level. Environment gaps (git/Docker/Postgres absence) tracked in docs/risks.md KR-1/2.
