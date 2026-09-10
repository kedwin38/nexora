# NEXORA ISP OS

Multi-tenant, policy-driven ISP operating system — Railway-first. Many
companies ("tenants") run their own hotspot/ISP business on one deployment,
each with its own staff, customers, packages, routers and M-Pesa collection.
A platform owner governs the whole estate. Control loop:

```
BUSINESS STATE → POLICY RESOLUTION → DESIRED NETWORK STATE → NETWORK CONTROL
→ ACTUAL NETWORK STATE → TELEMETRY/USAGE → RECONCILIATION → POLICY RE-EVALUATION
```

### Highlights

- **Multi-tenant**: company self-signup, per-tenant data isolation, a
  platform-owner console over all companies. See `docs/MULTI_TENANCY.md`.
- **M-Pesa Pay Bill *and* Till (Buy Goods)**, per-company Daraja credentials
  encrypted at rest, and a payment lifecycle where **nothing is left
  hanging** — every payment ends SUCCESS / CANCELLED / EXPIRED / FAILED via
  callback or a reconciliation sweep. See `docs/PAYMENTS.md`.
- **Router provisioning** (MikroTik RouterOS + Tenda) with verified
  read-back and drift reconciliation. Setup commands in `docs/ROUTER_SETUP.md`.

### Guides

- `docs/USER_GUIDE.md` — customers, company staff, platform owner, first-run
- `docs/ROUTER_SETUP.md` — MikroTik / Tenda commands and connectivity patterns
- `docs/PAYMENTS.md` — paybill/till config and the payment lifecycle
- `docs/MULTI_TENANCY.md` — how tenancy and the platform owner work
- `PROJECT_STATE.md` (always current) · `CHECKPOINT.md` (latest verified state)

## Layout

```
apps/
  api/              Fastify REST API + webhooks (public)
  worker/           Outbox/event/job consumer (private)
  network-worker/   Router control via adapters (private)
  scheduler/        Cron → job records (private)
  web/              Customer / guest / admin portals (Stage 7)
packages/
  domain/           Kernel: IDs, Result, errors, events, state machines
  contracts/        Event catalog + API wire contracts
  config/           zod environment parsing
  logging/          pino wrapper with secret redaction
  events/           Outbox ports
  auth/             RBAC matrix + auth ports
  db/               Prisma schema + client (PostgreSQL — system of record)
  router-sdk/       RouterAdapter port, capabilities, canonical state
  payment-sdk/      PaymentProvider port, MSISDN utilities
docs/
  adrs/             Architecture Decision Records
  technical-debt.md
  risks.md
```

## Commands

```bash
npm install            # workspaces install
npm run db:generate    # prisma client
npm run db:validate    # schema validation
npm run typecheck      # tsc --noEmit all workspaces
npm run lint           # eslint
npm test               # vitest
npm run dev:api        # api with watch (needs .env)
npm run e2e            # embedded Postgres + full control-loop acceptance suite
```

## ADR index

Architecture Decision Records live in `docs/adrs/`. Notable recent ones:
ADR-013 (tenant credential encryption, AES-256-GCM).
