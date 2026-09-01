# CHECKPOINT — Stage 9 complete (chaos + security verified)

**Date:** 2026-09-01 (late) · **Status: primary E2E 27/27 · chaos/security 15/15 · unit 151/151**

Adds on top of Stages 6–8 core + 7 (previous checkpoint below):

## What Was Built

- **Shared harness** (`scripts/lib/harness.ts`): stack boot (embedded PG + 3 services), checkers, customer/admin/purchase/callback helpers — reused by both E2E suites.
- **Hardening: orphaned-op recovery** (§77 "worker crash leaves jobs recoverable") — network-worker requeues PROCESSING operations stale >60s (`RECOVERED_ORPHANED_PROCESSING`).
- **`npm run e2e:chaos`** (`scripts/e2e-chaos.ts`, 15 checks, ALL PASS):
  - *Chaos:* unknown-transaction callback acked without phantom payments; **amount tampering (1¢ for a Day Pass) rejected**; late callback cannot resurrect terminal payments; out-of-order replay after SUCCESS is a no-op; repurchase extends (renewal) never duplicates; concurrent purchases both activate exactly once; invalid op exhausts bounded retries → PERMANENT_FAILURE; **admin-repaired retry → SUCCESS**; **orphaned PROCESSING op reclaimed and completed**.
  - *Security:* RBAC matrix live-verified (SUPPORT_AGENT: payments 200 / summary 403 / retry 403); login brute-force → 429 (isolated via X-Forwarded-For); no-token/garbage/tampered-signature → 401; SQL-injection probes neutralized by Prisma parameterization; XSS payload stored as data and served as JSON only; **no PII in /metrics**.

## Defects found & fixed during verification

1. `fetch` hard-blocks port **5060** (Fetch-spec bad-port list, SIP) — chaos stack moved to :5070; lesson recorded.
2. Harness line corrupted during write (unterminated string) — byte-level repair.
3. Test-ordering bug in the harness itself: brute-force rate-limit test poisoned the later RBAC login — reordered + isolated by client IP.

## Verification

| Gate | Result |
|---|---|
| typecheck / lint / unit | ✅ / ✅ / **151/151** |
| `npm run e2e` | ✅ **27/27** (re-run after changes) |
| `npm run e2e:chaos` | ✅ **15/15** |

## Remaining (polish/ops only)

- Railway deployment of `web` + scheduler Cron entry; real SMS gateway sender; MikroTik hardware verification (KR-3); optional: LISTEN/NOTIFY push transport (ADR-011 revisit trigger).

## Blockers

- None local. Railway runtime awaits user env vars (RAILWAY_SETUP.md).

---

# (Previous) CHECKPOINT — Stages 6–8 core + 7 complete

**Date:** 2026-09-01 (night) · **Status: E2E 27/27, unit 151/151, web build ✓**

Adds on top of Stage 5 (previous checkpoint below):

## What Was Built

- **ADR-011**: Postgres-backed queue transport accepted for Phase 1 (supersedes TD-005 as a decision; BullMQ deferred until worker replication).
- **Notification engine** (§62): pure trigger templates (unit-tested: payment confirmed, activation, FUP warning/throttle, expiry, router offline), idempotent outbox fan-out (metadata.outboxEventId), `NotificationSender` port + **LogSender** (operator trail; SMS gateway plugs in later), worker delivery loop with bounded retries — **E2E-verified: PAYMENT_CONFIRMED → SENT**.
- **Prometheus `/metrics`** on the API (prom-client): default process metrics + `nexora_http_request_duration_seconds` histogram, `nexora_payments_total{outcome}`, live gauges (active sessions/subscriptions/queued ops via collect-on-scrape) — **E2E-verified**.
- **Stage 7 — Next.js portal** (`apps/web`, Next 15 App Router, no runtime deps beyond react):
  - `/auth/login` dual-panel (operator Argon2id login / customer phone register+login)
  - `/dashboard`: status, package, speed, expiry, **FUP usage bar with state pill**, 10s live poll
  - `/packages`: catalog + selection + STK purchase with status polling → auto-redirect on confirmation
  - `/admin`: 5-tab command center (overview KPIs, customers, payments, live sessions + DISCONNECT, network ops + RETRY) with 10s refresh
  - Same dark NOC design language; `/api/*` proxied via Next rewrites (single origin)
  - **`next build` ✓** (7s); dev: `npm run dev -w @nexora/web` (:3000 → :5000)

## Verification

| Gate | Result |
|---|---|
| typecheck (14 workspaces) / lint | ✅ exit 0 (web linted by its own build) |
| unit | ✅ **151/151** (10 files — +notification templates/sender) |
| bundles ×3 services + web build | ✅ |
| **E2E** | ✅ **27/27** — new: /metrics exposed, notification delivered (SENT) |

## Remaining

- Stage 9: chaos/torture extensions to E2E (out-of-order callbacks, worker restart mid-op, concurrent purchases, router-timeout storms), security suite, backup/restore drill.
- Ops polish: Railway service for `web` (public) + scheduler Cron entry; SMS gateway credentials → real sender; MikroTik hardware verification (KR-3).

## Blockers

- None local. Railway runtime awaits user env vars (RAILWAY_SETUP.md).

---

# (Previous) CHECKPOINT — Stage 5 complete (control loop closed end-to-end)

**Date:** 2026-09-01 (evening) · **Status: COMPLETE — E2E 25/25 green, 146/146 unit tests**

Previous checkpoint (Stages 1–4 core + 6 core + portal) is summarized below; this checkpoint adds **Stage 5: Runtime & Control**.

## What Was Built

### packages/engines (new workspace)
- **Usage engine** (§19, §22): per-router cycle reads active sessions + counters via adapter; auto-creates ONLINE CustomerSessions for authorized devices seen on the router (AAA accounting-lite) and ends ROUTER_TIMEOUT sessions; `computeDelta` with rollover protection (unit-tested); accumulates session bytes + FUP usage + hourly UsageRecords; UsageSnapshot raw trail.
- **FUP engine** (§20): evaluation cycle over FUP states — NORMAL→WARNING (informational) →FUP_REACHED→THROTTLED (speed change: subscription→FUP, desired state version bump, APPLY_POLICY op, FUP_THROTTLED event); restore path re-activates; `resetFupForSubscription` admin command.
- **Expiry engine** (§21): past-due ACTIVE/FUP/SUSPENDED/PROVISIONING_FAILED → EXPIRED + desired-state revocation (authorized:false, version bump) + DEAUTHORIZE op + session termination + outbox + audit. Payment state untouched (invariants #3/#7).
- **Reconciliation engine** (§26–§27): desired-vs-actual per subscriber via adapter read-back — match → `synchronizedAt`; drift → RECONCILE_SYNC repair op + NETWORK_DRIFT_DETECTED; **Router health** poller → Router.status transitions + ROUTER_ONLINE/OFFLINE events.

### Service wiring
- **scheduler** (§6.5): interval tick enqueues deduped Job rows (6 types) — cron triggers work, never runs it (invariant #11).
- **worker**: job runner for DB-bound types (subscription-expiry, fup-evaluation, session-cleanup) + outbox dispatcher.
- **network-worker**: job runner for router-bound types (usage-sync, network-reconciliation, router-health) + operation executor with **operation-aware read-back verification** (presence+match for authorizations; absence for deauthorizations).
- **API**: admin sessions list / session disconnect / FUP reset endpoints (§55, audited); customer `/me` now exposes FUP state (used/limit) and full subscription detail.

## Verification

| Gate | Result |
|---|---|
| typecheck / lint | ✅ exit 0 |
| unit tests | ✅ **146/146** (9 files — added computeDelta rollover, isExpirable, FUP promotion) |
| bundles ×4 | ✅ |
| **E2E (`npm run e2e`)** | ✅ **25/25** — prior 15 + usage-sync session auto-create, FUP throttle (sub→FUP, desired v2 @1280k, APPLY_POLICY SUCCESS), reconciliation synchronized (checked=1), expiry (EXPIRED, DEAUTHORIZE SUCCESS, session terminated, /me reflects) |

**Defects found & fixed during verification:**
1. `evaluateFupState` never promoted FUP_REACHED→THROTTLED (throttle action must latch) — fixed + tests.
2. Webhook wrote `NetworkPolicy.desiredState.macAddress: null` — broke FUP ops, reconciliation (checked=0) and expiry deauth in one shot; device MAC now bound at activation.
3. FUP engine query list omitted FUP_REACHED (second cycle invisible) and bumped desired state on mere WARNING (noise ops) — fixed.
4. Executor treated deauth read-back `matchesDesired=null` as mismatch — absence is success for DEAUTHORIZE/REMOVE_POLICY; verification is now operation-aware.

## Remaining (next stages)

- **Stage 6 rest**: BullMQ transport for outbox→queue; workflow orchestration hardening.
- **Stage 7**: Next.js portals (customer/guest/admin NOC) replacing the interim portal; admin package CRUD + user/role management UI.
- **Stage 8**: notification engine (SMS/email triggers on existing outbox events), Prometheus `/metrics`, Railway config polish.
- **Stage 9**: extend E2E into chaos/torture suites (out-of-order events, worker restart mid-op, concurrent purchases), security tests.

## Blockers

- None local. Railway runtime awaits user env vars (RAILWAY_SETUP.md). MikroTik adapter awaits hardware (KR-3).

---

# (Previous) CHECKPOINT — Stages 2–4 core + 6 core + interim portal

## What Was Built

### Stage 2 — Identity & Security ✅
- **Argon2id hasher** (`@nexora/auth/argon2.ts`, OWASP params) + tests
- **HMAC token service**: `nxs_` tokens (HMAC-SHA256, SESSION_SECRET), staff tokens revocable via Prisma `UserSession` (sha256 hashes), customer tokens stateless (TD-004)
- **API auth plugin**: Bearer→principal, `requirePermission()` RBAC guard, `requireCustomer()`, append-only `writeAudit()`
- **Endpoints**: `/api/v1/auth/{login,logout,me}` (rate-limited 5/15min, decoy-hash timing path, login audit), `/api/v1/customers/{register,login,me}`
- Passwords: Argon2id; customers = phone-number identity (MSISDN-normalized)

### Stage 3 — Commerce ✅
- **`GET /api/v1/packages`** public catalog
- **`POST /api/v1/payments/initiate`** (customer, rate-limited): idempotent via `UNIQUE(provider, clientReference)`; Payment INITIATED→PENDING; PaymentAttempt; device MAC upsert→Device; `GET /api/v1/payments/:id` (owner or payment.read)
- **`POST /api/v1/webhooks/mpesa`**: parse→bind to own CheckoutRequestID→idempotent replay ack→amount verify→**single $transaction**: Payment SUCCESS + Subscription ACTIVE (immutable policySnapshot, billing period, priceAtPurchase, fupThreshold) + FupState NORMAL + NetworkPolicy desiredState v1 + NetworkOperation AUTHORIZE (idempotencyKey `authorize:<sub>:v1`) + outbox (PAYMENT_CONFIRMED, SUBSCRIPTION_ACTIVATED/RENEWED, NETWORK_PROVISION_REQUESTED) + AuditLog. Renewal extends existing sub.
- **Daraja provider**: OAuth cache, STK push (timestamp+base64 password, tested), query, callback parser (pure, tested); **Mock provider** for local/E2E

### Stage 4 — Network core ✅
- **MockRouterAdapter**: full contract in-memory router (idempotent authorize, readback, drift) + tests
- **MikroTikAdapter**: RouterOS API (`node-routeros`, `=key=value` wire format): ip-binding authorize/deauthorize, simple-queue rate limits, prints for readback/health/usage (KR-3: hardware verification pending)
- **network-worker executor**: atomic claim (QUEUED/RETRYING→PROCESSING) → adapter command → VERIFYING (reconcileSubscriber readback) → SUCCESS / RETRYING (exponential backoff, bounded) / PERMANENT_FAILURE (+NETWORK_PROVISION_FAILED outbox). Admin retry re-queues (machine extended PERMANENT_FAILURE→QUEUED).
- **Policy resolver** (pure, tested): package vs FUP-throttled vs suspended speeds; `evaluateFupState` percentages

### Stage 6 — Events core ✅
- **worker outbox dispatcher**: polls PENDING due events → DISPATCHED + SystemEvent trail; retries w/ backoff → DEAD
- Outbox writes wired at every business mutation (register, initiate, callback tx)

### Interim portal ✅
- Dark NOC single-page portal served by API at `/`, `/auth/login`, `/dashboard`, `/packages`, `/admin` (Interface Aesthetic Directive: void background, monospace data, severity pills). Customer purchase flow with STK status polling; admin summary/payments/network-ops (with RETRY)/RBAC. Next.js `apps/web` remains Stage 7 (TD-001).

### Infra
- **Embedded PostgreSQL** devDependency + `npm run e2e` harness (`scripts/e2e.ts`): boots PG 17.5, migrates, seeds, starts api+worker+network-worker, runs acceptance flows A-core/C/E + RBAC + outbox + audit + portal checks. KR-1 fully resolved.
- Env: `PAYMENT_PROVIDER`, `ROUTER_ADAPTER` (mock defaults), `SESSION_TTL_HOURS`, `CORS_ORIGIN`; api boots without M-Pesa creds

## Verification

| Gate | Result |
|---|---|
| typecheck (13 workspaces, strict) | ✅ exit 0 |
| lint | ✅ exit 0 |
| unit tests | ✅ **140/140** (8 files: machines, policy, RBAC, tokens, argon2, daraja, mock router, msisdn) |
| bundles ×4 | ✅ (argon2 external; source-map-support dep) |
| **`npm run e2e`** | ✅ **15/15 PASS** — health, register, catalog, initiate, idempotent replay, webhook tx, payment SUCCESS+sub, duplicate-callback single-sub, network op SUCCESS (read-back), admin login, admin summary, RBAC 403, outbox dispatched(5), audit row, portal 200 |

**Defects found & fixed:** tokens.issue port arity; Payment↔Package relation missing (schema + regenerated migration); Customer compound-unique lookup; dead SUCCESS branch; import.meta.url in CJS bundle; argon2 `.node` bundling; node-routeros source-map-support; Windows npx spawn (shell:true); FUP cyclic terminal-state test invariant.

## Not Yet Built (next stages)

- Stage 5: session engine (real hotspot sessions/usage ingestion), FUP evaluation loop, expiry engine, reconciliation loop
- Stage 6 rest: BullMQ queue transport (dispatcher currently marks DISPATCHED in-process)
- Stage 7: Next.js portals (customer/guest/admin) replacing interim portal; admin package CRUD + user/role management UI
- Stage 8: scheduler cron jobs (expiry/FUP/usage/health/reconciliation), notifications (SMS/email), prometheus metrics
- Stage 9: full torture/chaos/security suites (e2e harness is the seed — extend it)

## Blockers

- None local. Railway runtime still awaits env vars per RAILWAY_SETUP.md (user action). MikroTik adapter awaits real hardware (KR-3).
