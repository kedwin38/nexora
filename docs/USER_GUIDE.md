# NEXORA User Guide

NEXORA is a multi-tenant ISP operating system: many companies ("tenants")
run their own hotspot/ISP business on one platform. This guide covers the
three audiences — **customers**, **company staff**, and the **platform
owner** — plus setup.

- Router preparation: see [ROUTER_SETUP.md](./ROUTER_SETUP.md)
- Payments (paybill & till): see [PAYMENTS.md](./PAYMENTS.md)
- How tenancy works: see [MULTI_TENANCY.md](./MULTI_TENANCY.md)
- Deploying: see [../RAILWAY_SETUP.md](../RAILWAY_SETUP.md)

---

## 1. For customers (buying internet)

You don't need an account to get online as a guest.

1. Connect to the company's Wi‑Fi; the captive portal opens the NEXORA
   purchase page.
2. Pick a package (e.g. *Hour Pass*, *Day Pass*, *Week Pass*).
3. Enter your M‑Pesa phone number and tap **Pay**. An STK push pops up on
   your phone — enter your M‑Pesa PIN.
4. On confirmation you're online automatically. You get an **access code**
   to check status later.

**If the prompt is cancelled or times out**, no money is deducted and the
payment is closed as *cancelled* / *timed out* — just try again. You're
never left in a stuck "pending" state.

Registered customers additionally get a dashboard showing the active
package, speed, data used vs. the FUP allowance, and expiry.

## 2. For company staff (running your ISP)

### 2.1 Create your company

Open the portal and choose **Create a company**. Provide a company name, an
admin email + password, and a contact phone. You become your company's
`SUPER_ADMIN` and get a ready-to-sell starter catalogue (you can edit it).

### 2.2 Configure M‑Pesa collection

**Admin → Settings → Payments.** Choose **Pay Bill** or **Till (Buy
Goods)**, enter your shortcode (and till number for Buy Goods), and your
Daraja credentials (Consumer Key/Secret and Passkey). Credentials are
encrypted at rest. See [PAYMENTS.md](./PAYMENTS.md) for where to get them.

### 2.3 Add your router

Prepare the router using [ROUTER_SETUP.md](./ROUTER_SETUP.md), then register
it under **Admin → Network**. NEXORA health-checks it every minute.

### 2.4 Packages, customers, sessions

- **Packages** — create/edit speed, duration, price, device cap, and FUP
  limits. Edits create a new version; active subscriptions keep the policy
  they were sold under (history is immutable).
- **Customers** — a 3‑pane inspector shows *business* state, *desired*
  network state, and *actual* (verified) network state, plus a drift verdict.
- **Sessions** — view live sessions; disconnect one if needed.
- **Staff & roles** — invite staff and assign roles (`NETWORK_ADMIN`,
  `BILLING_ADMIN`, `SUPPORT_AGENT`, `ANALYST`, `READ_ONLY`). Role changes
  revoke live sessions and are audited.

Everything you see is scoped to **your** company only.

### 2.5 Roles at a glance

| Role | Can do |
|------|--------|
| `SUPER_ADMIN` | Everything within the company (incl. settings, staff, payments) |
| `NETWORK_ADMIN` | Routers, sessions, policy, FUP, reconciliation |
| `BILLING_ADMIN` | Customers, packages, payments, refunds, reconciliation |
| `SUPPORT_AGENT` | Read customers/subscriptions/payments; disconnect a session |
| `ANALYST` | Read-only across the company + monitoring |
| `READ_ONLY` | Read-only essentials |

## 3. For the platform owner

The platform owner sits above every company. Log in with the platform-owner
credentials and open the **Owner** console to see:

- **Estate summary** — total companies, active companies, customers, active
  subscriptions, revenue, staff, routers online, pending/expired/cancelled
  payments, failed network operations.
- **Per-company breakdown** — customers, active subscriptions, revenue, and
  whether each company has configured M‑Pesa.
- **System health** — outbox backlog, dead-letter events, job queue, failed
  jobs, offline routers, live sessions.
- **Company controls** — suspend or reactivate a company (a suspended
  company cannot transact).

The platform owner cannot be created through the company admin UI; it is
seeded from `PLATFORM_OWNER_EMAIL` / `PLATFORM_OWNER_PASSWORD`.

## 4. First-run setup checklist

1. Deploy per [RAILWAY_SETUP.md](../RAILWAY_SETUP.md); set `SESSION_SECRET`,
   `DATABASE_URL`, `REDIS_URL`.
2. Set `CREDENTIALS_ENCRYPTION_KEY` (≥32 chars) so companies can store M‑Pesa
   credentials: `openssl rand -hex 32`.
3. Set `PLATFORM_OWNER_EMAIL` / `PLATFORM_OWNER_PASSWORD` and run the seed.
4. (Single-tenant) set `ADMIN_EMAIL` / `ADMIN_PASSWORD` for the `default`
   company's super admin.
5. Set `PUBLIC_BASE_URL` so M‑Pesa callbacks resolve.
6. Prepare a router ([ROUTER_SETUP.md](./ROUTER_SETUP.md)) and register it.
7. Configure M‑Pesa ([PAYMENTS.md](./PAYMENTS.md)) and run a test purchase.
