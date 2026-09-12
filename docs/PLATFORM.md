# Platform (Owner) — Subscriptions, Billing & AI Monitoring

NEXORA is two-sided. There are **two distinct payment relationships**, each
configured independently on its own M-Pesa account:

| | ISP → Customer | Owner → ISP (platform) |
|---|---|---|
| Who pays | a subscriber buying internet | a company paying for NEXORA |
| Who is paid | the **company's** Daraja account | the **platform's** Daraja account |
| What it buys | a data package / session | a monthly subscription tier |
| Config lives on | the company's Tenant row | the reserved `platform` tenant |
| Code path | `paymentsFor(tenantId)` | `paymentsFor('platform')` |

Both sides share the **same encrypted Daraja abstraction** (ADR-013): the owner
configures Pay Bill or Till exactly the way a company does, and credentials are
stored AES-256-GCM encrypted, never in plaintext.

## 1. Subscription tiers

The owner sells monthly plans (`SubscriptionPlan`): **Starter**, **Growth**,
**Scale** (seeded by default; editable under *Owner → Plans*). A plan carries a
price, an interval, a trial length, and soft limits (staff / routers /
customers). Assigning a plan to a company starts a **trial** — no invoice is
raised until the trial's `currentPeriodEnd` lapses.

## 2. Invoice lifecycle — nothing ever hangs

The recurring billing cycle (`platform-billing`, hourly) issues a `PENDING`
`PlatformInvoice` when a company's period lapses and advances the period. From
there every invoice is tracked to a **terminal** state — it is never left
hanging:

```
PENDING ──STK paid──────────────▶ PAID        (tenant restored to ACTIVE)
   │
   ├──STK cancelled (1032)──────▶ attempt closed, invoice stays PENDING (retryable)
   ├──STK timed out────────────▶ attempt closed by reconciliation (retryable)
   └──past due date────────────▶ OVERDUE  (tenant → PAST_DUE)
```

- A company pays from *Admin → Billing* (`POST /api/v1/admin/billing/invoices/:id/pay`),
  which sends an STK push to the **platform** shortcode.
- A second attempt while one is in flight is refused (`409`) — no double charge.
- The M-Pesa callback marks the invoice `PAID` and restores the company to
  `ACTIVE`; a non-zero / cancelled result closes just the *attempt* so the
  company can retry, leaving the invoice owed.
- `runPlatformInvoiceReconciliation` (part of the `payment-reconciliation` job)
  sweeps in-flight attempts: `SUCCESS` → paid, terminal failure/cancel/timeout →
  attempt closed, past the hard deadline → attempt closed. This mirrors the
  customer-payment lifecycle so a stuck STK never wedges an invoice.

## 3. Elite owner permissions

The `PLATFORM_OWNER` role holds **every** permission, including the cross-tenant
`platform.*` set (`platform.analytics.read`, `platform.tenants.manage`,
`platform.plans.manage`, `platform.billing.manage`, `platform.payments.manage`,
`platform.insights.manage`, `platform.impersonate`). A company `SUPER_ADMIN`
holds every tenant-scoped permission but **never** `platform.*` — they can never
see or touch another company. Owner endpoints live under `/api/v1/platform/*`
behind `requirePlatformOwner`.

*Owner → Analytics* shows registered companies, MRR, GMV, platform revenue,
14-day revenue trend, plan breakdown, and the top ISPs by revenue.

## 4. AI operations monitor

`platform-monitor` (every 15 min, also *Owner → Insights → Run scan now*) scans
the whole estate and writes `PlatformInsight` rows the owner reads as an AI feed:
payment-failure spikes, stuck payments, revenue drops, offline routers, dead /
backlogged events, failing jobs, past-due companies, and new signups. Each
signal is deduped within a 12-hour window so the feed doesn't spam.

Today the signals are **rule-based**. The engine exposes an LLM seam
(`runMonitorCycle(prisma, { narrate })`): wire an Anthropic call into `narrate`
behind an env flag to add natural-language summaries — the heuristics run with
or without it.

## 5. Role-scoped portal

The single-page portal renders navigation and tabs from the caller's
permissions (`/api/v1/auth/me`). Each staff role under a company sees only its
own pages:

| Role | Sees |
|---|---|
| `SUPER_ADMIN` | everything for their company (overview, customers, packages, network, staff, billing, settings) |
| `NETWORK_ADMIN` | overview, customers, network operations |
| `BILLING_ADMIN` | customers, packages, **billing** (platform invoices) |
| `SUPPORT_AGENT` | customers, sessions |
| `ANALYST` / `READ_ONLY` | read-only overview |
| `PLATFORM_OWNER` | the owner console (analytics, companies, plans, invoices, platform payments, AI insights) |

Every authenticated view carries a **Logout** control (`POST /api/v1/auth/logout`),
which revokes the session token server-side and clears local credentials.
