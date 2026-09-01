# RAILWAY SETUP — NEXORA ISP OS

The 2026-09-01 deployment crash-loop (`EnvValidationError: DATABASE_URL/REDIS_URL/SESSION_SECRET Required`)
means the services built and booted correctly but have **no data services attached and no secrets set**.
Follow this runbook in order.

---

## 1. Attach data services (project level)

In the Railway project → **New** → **Database**:

| Service | Provides |
|---|---|
| **PostgreSQL** | `DATABASE_URL` (+ internal `PG*` vars) |
| **Redis** | `REDIS_URL` |

Both stay **private** (do not enable public TCP proxy).

## 2. Set variables on each app service

### `api` (public service)

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `SESSION_SECRET` | random string ≥ 32 chars (e.g. `openssl rand -hex 32`) |
| `NODE_ENV` | `production` |
| `APP_ENV` | `production` |
| `LOG_LEVEL` | `info` |
| `ADMIN_EMAIL` | super-admin email (used by one-time seed, step 4) |
| `ADMIN_PASSWORD` | super-admin password — **delete the variable after seeding** |

`PORT` is injected by Railway automatically and honored by the app.

> M-Pesa variables (`MPESA_*`) are **not required yet** — payments land in Stage 3.
> The API boots without them by design.

### `worker`, `network-worker`, `scheduler` (private services)

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |

## 3. Service settings

- **Root Directory:** repo root (`nexora/`) for all app services — the build needs the monorepo.
  If you set per-app root directories, the per-app `apps/*/railway.json` files supply
  build/start/healthcheck settings; the `api` one includes the pre-deploy migration.
- **api:** set **Healthcheck Path** = `/health/live` (readiness probe: `/health/ready`).
- **worker / network-worker / scheduler:** keep **private** (no public domain needed).

## 4. First deployment sequence

1. Redeploy **api** — its `preDeployCommand` runs `prisma migrate deploy`
   (the initial migration ships in `packages/db/prisma/migrations/`).
2. After api is live, open a **service shell (Terminal)** on `api` and seed once:

   ```bash
   npm run seed --workspace @nexora/db
   ```

   This creates roles/permissions, the super admin (from `ADMIN_EMAIL`/`ADMIN_PASSWORD`),
   three starter packages and the test router entry.
3. **Delete `ADMIN_EMAIL` / `ADMIN_PASSWORD` variables** after seeding.
4. Redeploy the three private services.

## 5. Verify

| Check | Expected |
|---|---|
| `GET https://<api-domain>/health/live` | `200 {"status":"ok"}` |
| `GET https://<api-domain>/health/ready` | `200` with `postgres: "up"` |
| worker / network-worker / scheduler logs | `started; ... arrive in Stage N` heartbeat, no restart loop |

## Troubleshooting

- **`DATABASE_URL: Required`** → the reference variable `${{Postgres.DATABASE_URL}}` is missing
  or the Postgres service is in a different environment. Re-check step 2.
- **`SESSION_SECRET must be at least 32 characters`** → generate a longer secret.
- **Healthcheck failing but container runs** → confirm the service exposes the port Railway
  injected (`PORT`) — the app binds `HOST=0.0.0.0` and `PORT` automatically.
- **`P1001: Can't reach database server`** → Postgres is still starting; the restart policy
  will recover it, or redeploy after Postgres shows healthy.
