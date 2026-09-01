# NEXORA ISP OS

Policy-driven ISP operating system — Railway-first. Control loop:

```
BUSINESS STATE → POLICY RESOLUTION → DESIRED NETWORK STATE → NETWORK CONTROL
→ ACTUAL NETWORK STATE → TELEMETRY/USAGE → RECONCILIATION → POLICY RE-EVALUATION
```

Status: **Stage 1 (Foundation)** — see `PROJECT_STATE.md` (always current) and `CHECKPOINT.md` (latest verified state).

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
```
