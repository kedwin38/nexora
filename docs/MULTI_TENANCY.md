# Multi-Tenancy

NEXORA runs many companies ("tenants") on one deployment. A tenant is an ISP
business: its own staff, customers, packages, routers, subscriptions and
payments. Nothing crosses the tenant boundary.

## Reserved tenants

| id | Purpose |
|----|---------|
| `default` | Reference ISP for single-tenant deployments and tests. Pre-existing data and the seeded `ADMIN_EMAIL` super admin live here. |
| `platform` | Home of the `PLATFORM_OWNER`. Governs all tenants; owns no ISP customers. |

## Identity & scope

- Every staff `User`, `Customer`, `Package`, `Subscription`, `Router`,
  `Payment` and `Notification` carries a `tenantId`.
- Session tokens embed `tenantId`; the request principal carries it.
- All company-facing admin queries filter by `principal.tenantId`, so a
  company admin only ever sees their own data.
- `PLATFORM_OWNER` uses the separate `/api/v1/platform/*` surface to see the
  whole estate; the `platform.*` permissions are granted to that role alone.

## How a request's tenant is resolved

- **Authenticated staff/customers:** from the token principal.
- **Public captive-portal requests** (package list, customer register/login,
  guest purchase): from a tenant **slug** supplied as the `x-tenant` header,
  a `?tenant=` query parameter, or a `tenant` body field. Unknown, suspended,
  or absent → the `default` tenant (keeps single-tenant deployments simple).

A suspended or closed company cannot transact — public resolution refuses to
route to it.

## Company self-signup

`POST /api/v1/tenants/signup` (gated by `ALLOW_TENANT_SIGNUP`) creates the
tenant, its first `SUPER_ADMIN`, and a starter catalogue cloned from
`default` so the company can sell immediately. It returns a staff token.

## Per-tenant M-Pesa

Each company configures its own paybill/till and Daraja credentials
(encrypted at rest). Payment initiation and reconciliation resolve the
provider from the paying customer's tenant; a company with no own config
falls back to the platform default (mock in dev, or the env-configured
Daraja app). See [PAYMENTS.md](./PAYMENTS.md).

## Platform governance

The platform owner can:

- view an estate-wide summary and a per-company breakdown,
- inspect a single company's stats,
- **suspend** / **reactivate** a company (reserved tenants are protected),
- read system health (outbox backlog, dead events, jobs, routers, sessions).

## Notes & limitations

- Staff email is globally unique (email = identity across the platform).
- `AuditLog` has no `tenantId` column; company admins see audit entries by
  their own staff plus system/worker actions, while the platform owner sees
  all. A future migration may add an explicit `tenantId` to audit rows.
