# System Autopsy — Findings & Fixes

A full-system audit (2026-09-10) after the multi-tenancy/payments work. The
data, auth and payment planes were tenant-safe; the network plane and a few
edges were not. All findings below are **fixed** and covered by tests.

| # | Sev | Finding | Fix | Test |
|---|-----|---------|-----|------|
| F1 | 🔴 | Provisioning (activation/expiry/FUP) picked the oldest router across ALL tenants → one company's subscriber authorized on another's router | Router lookups scoped by the subscription's `tenantId` | e2e "provisioning uses the customer's OWN tenant router" |
| F2 | 🔴 | network-worker drove a single router with every tenant's policies | Worker iterates all routers; usage-sync/reconciliation scoped to each router's tenant | e2e provisioning isolation + drift |
| F3 | 🟠 | Webhook parsed with the platform-default provider → real Daraja callbacks dropped when default is `mock` (the recommended mixed mode) | Webhook parses the Daraja shape first, falls back to the configured provider | e2e "real Daraja callback confirmed under mock platform default" |
| F4 | 🟠 | Double-activation race (webhook + reconciliation) could create two subscriptions for one payment | Atomic claim (`updateMany PENDING→SUCCESS`) serializes racers; loser returns the winner's subscription | e2e "concurrent callbacks activate exactly once" |
| F5 | 🟡 | Suspended tenants silently rerouted public traffic to `default`; staff kept working | `resolveTenantId` refuses suspended/closed (403); suspend revokes staff sessions and blocks the payment path | e2e "suspended company refuses…/staff revoked/reactivated" |
| F6 | 🟡 | Unvalidated `?status=` reached Prisma → 500 | Validate against the enum → 400 | covered by admin routes |
| F7 | 🟡 | `ALLOW_TENANT_SIGNUP` defaulted on | Defaults off; opt in explicitly | — |
| F9 | 🟢 | Duplicated STK-deadline literal | Shared `STK_DEADLINE_MS` constant | — |
| F10 | 🟢 | `AuditLog` had no `tenantId` | Added column + migration + indexed scoping | migration + audit e2e |

**Accepted as-is (documented):** F8 (mock auto-confirm is dev-only and guarded),
F11 (`CORS_ORIGIN` configurable; pin in prod), F12 (cross-tenant row
consistency is app-enforced), and the one-router-per-tenant assumption for
multi-site reconciliation (see `MULTI_TENANCY.md`).

**Validation after fixes:** unit 178/178 · e2e 56/56 · chaos/security 15/15 ·
typecheck + lint clean.
