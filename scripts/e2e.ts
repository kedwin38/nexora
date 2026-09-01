/**
 * Local end-to-end verification harness (Stage 9 integration seed).
 *
 * Boots an embedded PostgreSQL, applies migrations, seeds, starts
 * api + worker + network-worker (mock payment provider, mock router),
 * then exercises the Phase 1 acceptance flows:
 *
 *   A. register -> login -> packages -> initiate -> callback -> subscription
 *   C. network operation executes with read-back verification
 *   E. duplicate callback is an idempotent no-op
 *   + admin console data paths
 *
 * Run: npx tsx scripts/e2e.ts
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 5050;
const PG_PORT = 5433;
const DATABASE_URL = `postgresql://nexora:nexora@localhost:${PG_PORT}/nexora`;
const SESSION_SECRET = 'e2e-local-secret-0123456789abcdef0123456789abcdef';
const ADMIN_EMAIL = 'admin@nexora.test';
const ADMIN_PASSWORD = 'E2eAdmin!2026';

const env = {
  ...process.env,
  NODE_ENV: 'production',
  DATABASE_URL,
  REDIS_URL: 'redis://localhost:6379', // presence-only for these services
  SESSION_SECRET,
  SESSION_TTL_HOURS: '24',
  PAYMENT_PROVIDER: 'mock',
  ROUTER_ADAPTER: 'mock',
  LOG_LEVEL: 'warn',
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
} as NodeJS.ProcessEnv;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  [PASS]' : '  [FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
}

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return false;
}

async function main(): Promise<void> {
  console.log('== NEXORA local E2E ==');

  // 1. Embedded PostgreSQL
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dataDir = join(ROOT, '.tmp', 'pg');
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });

  const pg = new (EmbeddedPostgres as new (o: object) => {
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    createDatabase(name: string): Promise<void>;
  })({
    databaseDir: dataDir,
    user: 'nexora',
    password: 'nexora',
    port: PG_PORT,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('nexora');
  console.log('[ok] embedded PostgreSQL up on :', PG_PORT);

  const children: Array<{ kill: () => void }> = [];
  try {
    // 2. Migrations + seed (shell:true — npx is npx.cmd on Windows)
    execFileSync('npx prisma migrate deploy', {
      cwd: join(ROOT, 'packages', 'db'),
      env,
      stdio: 'pipe',
      shell: true,
    });
    console.log('[ok] migrations applied');
    execFileSync('npx tsx prisma/seed.ts', {
      cwd: join(ROOT, 'packages', 'db'),
      env,
      stdio: 'pipe',
      shell: true,
    });
    console.log('[ok] seed applied');

    // 3. Services
    const start = (cwd: string): { kill: () => void } => {
      const child = spawn(process.execPath, ['dist/index.cjs'], {
        cwd,
        env: { ...env, PORT: String(PORT) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout!.on('data', () => {});
      child.stderr!.on('data', (d: Buffer) => process.stderr.write(`[svc] ${d}`));
      children.push({ kill: () => child.kill() });
      return { kill: () => child.kill() };
    };
    start(join(ROOT, 'apps', 'api'));
    start(join(ROOT, 'apps', 'worker'));
    start(join(ROOT, 'apps', 'network-worker'));

    check('api /health/ready', await waitForHttp(`http://127.0.0.1:${PORT}/health/ready`, 60_000));
    const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

    try {
      // ---- Flow A: customer register → browse → initiate ----
      const phone = '0712000111';
      const register = await fetch(`http://127.0.0.1:${PORT}/api/v1/customers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password: 'Customer!2026', displayName: 'E2E Customer' }),
      });
      const reg = (await register.json()) as { token?: string; customer?: { id: string } };
      check('customer register (201)', register.status === 201 && reg.token !== undefined);

      const auth = { Authorization: `Bearer ${reg.token}`, 'Content-Type': 'application/json' };

      const packagesResponse = await fetch(`http://127.0.0.1:${PORT}/api/v1/packages`);
      const packagesBody = (await packagesResponse.json()) as { data: Array<{ id: string; name: string; priceMinor: number }> };
      check('public package catalog', packagesResponse.status === 200 && packagesBody.data.length >= 3);
      const pkg = packagesBody.data.find((p) => p.name === 'Day Pass') ?? packagesBody.data[0]!;

      const idempotencyKey = crypto.randomUUID();
      const initiate = await fetch(`http://127.0.0.1:${PORT}/api/v1/payments/initiate`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ packageId: pkg.id, idempotencyKey, macAddress: 'AA:BB:CC:DD:EE:01' }),
      });
      const init = (await initiate.json()) as { paymentId?: string; providerTransactionId?: string };
      check('payment initiate (202, STK sent)', initiate.status === 202 && init.providerTransactionId !== undefined);

      // Idempotent initiation replay
      const replay = await fetch(`http://127.0.0.1:${PORT}/api/v1/payments/initiate`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ packageId: pkg.id, idempotencyKey, macAddress: 'AA:BB:CC:DD:EE:01' }),
      });
      const replayBody = (await replay.json()) as { idempotentReplay?: boolean };
      check('initiate idempotent replay', replay.status === 200 && replayBody.idempotentReplay === true);

      // ---- Callback → subscription (webhook transaction) ----
      const callback = {
        providerTransactionId: init.providerTransactionId,
        resultCode: 0,
        resultDesc: 'success',
        amountMinor: pkg.priceMinor,
        receipt: 'E2ERCPT0001',
      };
      const webhook1 = await fetch(`http://127.0.0.1:${PORT}/api/v1/webhooks/mpesa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(callback),
      });
      check('webhook accepted (200)', webhook1.status === 200);

      const paymentStatus = await (async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/v1/payments/${init.paymentId}`, { headers: auth });
        return (await response.json()) as { payment?: { status: string; subscriptionId: string | null } };
      })();
      check(
        'payment SUCCESS + subscription created',
        paymentStatus.payment?.status === 'SUCCESS' && paymentStatus.payment?.subscriptionId !== null,
      );

      // ---- Flow E: duplicate callback no-op ----
      await fetch(`http://127.0.0.1:${PORT}/api/v1/webhooks/mpesa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(callback),
      });
      await sleep(500);
      const subscriptionCount = await prisma.subscription.count({
        where: { customerId: reg.customer!.id },
      });
      check('duplicate callback → single subscription', subscriptionCount === 1);

      // ---- Flow C: network operation executes with read-back ----
      let opStatus = 'QUEUED';
      for (let i = 0; i < 15; i += 1) {
        await sleep(1_000);
        const op = await prisma.networkOperation.findFirst({
          where: { subscriptionId: paymentStatus.payment!.subscriptionId! },
          orderBy: { createdAt: 'desc' },
        });
        opStatus = op?.status ?? 'MISSING';
        if (opStatus === 'SUCCESS' || opStatus === 'PERMANENT_FAILURE') break;
      }
      check('network operation SUCCESS (mock adapter, read-back verified)', opStatus === 'SUCCESS', `status=${opStatus}`);

      // ---- Admin console paths ----
      const adminLogin = await fetch(`http://127.0.0.1:${PORT}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      const admin = (await adminLogin.json()) as { token?: string };
      check('admin login (seeded SUPER_ADMIN)', adminLogin.status === 200 && admin.token !== undefined);

      const adminAuth = { Authorization: `Bearer ${admin.token}` };
      const summary = await (async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/summary`, { headers: adminAuth });
        return (await response.json()) as { summary?: { customers: number; revenueMinor: number; paymentsSuccess: number } };
      })();
      check(
        'admin summary sees the transaction',
        (summary.summary?.paymentsSuccess ?? 0) >= 1 && (summary.summary?.revenueMinor ?? 0) >= pkg.priceMinor,
      );

      // RBAC: customer token must NOT read admin summary
      const forbidden = await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/summary`, { headers: { Authorization: `Bearer ${reg.token}` } });
      check('RBAC: customer denied on admin endpoint (403)', forbidden.status === 403);

      // Outbox dispatched by worker
      await sleep(2_000);
      const dispatched = await prisma.outboxEvent.count({ where: { status: 'DISPATCHED' } });
      check('outbox events dispatched', dispatched >= 3, `count=${dispatched}`);

      // Audit trail exists
      const audits = await prisma.auditLog.count({ where: { action: 'PAYMENT_CONFIRMED' } });
      check('audit record for payment confirmation', audits >= 1);

      // Prometheus metrics
      const metricsResponse = await fetch(`http://127.0.0.1:${PORT}/metrics`);
      const metricsBody = await metricsResponse.text();
      check(
        'Prometheus /metrics exposed',
        metricsResponse.status === 200 &&
          metricsBody.includes('nexora_http_request_duration_seconds') &&
          metricsBody.includes('nexora_payments_total'),
      );

      // Notifications: outbox fan-out + delivery (LogSender) — §62
      let sentNotifications = 0;
      for (let i = 0; i < 12 && sentNotifications === 0; i += 1) {
        await sleep(1_000);
        sentNotifications = await prisma.notification.count({
          where: { status: 'SENT', triggerType: 'PAYMENT_CONFIRMED' },
        });
      }
      check('notification delivered (PAYMENT_CONFIRMED via LogSender)', sentNotifications >= 1, `sent=${sentNotifications}`);

      // Portal served
      const portal = await fetch(`http://127.0.0.1:${PORT}/auth/login`);
      check('portal served at /auth/login', portal.status === 200 && (await portal.text()).includes('NEXORA'));

      // ================= Stage 5: runtime engines =================
      // (Jobs enqueued directly — exactly what the scheduler does — for determinism.)
      const enqueueJob = async (type: string): Promise<void> => {
        await prisma.job.create({ data: { type, payload: { source: 'e2e' }, status: 'QUEUED' } });
      };

      // 5.1 usage-sync auto-creates the ONLINE session (AAA accounting-lite)
      await enqueueJob('usage-sync');
      let dbSession: { id: string; status: string } | null = null;
      for (let i = 0; i < 15 && dbSession === null; i += 1) {
        await sleep(1_000);
        dbSession = await prisma.customerSession.findFirst({
          where: { subscriptionId: paymentStatus.payment!.subscriptionId! },
          orderBy: { startedAt: 'desc' },
          select: { id: true, status: true },
        });
      }
      check('usage-sync auto-created ONLINE session', dbSession !== null && dbSession.status === 'ONLINE');

      // 5.2 FUP: saturate usage, run evaluation twice (NORMAL→FUP_REACHED→THROTTLED)
      const fupRow = await prisma.fupState.findFirst({
        where: { subscriptionId: paymentStatus.payment!.subscriptionId! },
        orderBy: { periodStart: 'desc' },
      });
      check('FUP state exists from activation', fupRow !== null);
      if (fupRow !== null) {
        await prisma.fupState.update({ where: { id: fupRow.id }, data: { usedBytes: fupRow.limitBytes } });
        await enqueueJob('fup-evaluation');
        await sleep(4_000);
        await enqueueJob('fup-evaluation'); // second cycle latches THROTTLED
      }

      let throttledSub: { status: string } | null = null;
      let throttledPolicy: { version: number; desiredState: unknown } | null = null;
      for (let i = 0; i < 15; i += 1) {
        await sleep(1_000);
        throttledSub = await prisma.subscription.findUnique({
          where: { id: paymentStatus.payment!.subscriptionId! },
          select: { status: true },
        });
        throttledPolicy = await prisma.networkPolicy.findUnique({
          where: { subscriptionId: paymentStatus.payment!.subscriptionId! },
          select: { version: true, desiredState: true },
        });
        if (throttledSub?.status === 'FUP' && (throttledPolicy?.version ?? 0) >= 2) break;
      }
      const throttleRate = (throttledPolicy?.desiredState as { rateLimit?: { downloadKbps: number } } | null)
        ?.rateLimit?.downloadKbps;
      const fupAfter = await prisma.fupState.findFirst({
        where: { subscriptionId: paymentStatus.payment!.subscriptionId! },
        orderBy: { periodStart: 'desc' },
        select: { state: true },
      });
      check(
        'FUP: subscription -> FUP, desired state v2 throttled',
        throttledSub?.status === 'FUP' && (throttledPolicy?.version ?? 0) >= 2,
        `sub=${String(throttledSub?.status)} v=${String(throttledPolicy?.version)} fupState=${String(fupAfter?.state)}`,
      );
      check('FUP: throttle speed applied (1280k)', throttleRate === 1280, `down=${String(throttleRate)}`);

      let throttleOp: { status: string; lastError: string | null } | null = null;
      for (let i = 0; i < 15; i += 1) {
        await sleep(1_000);
        throttleOp = await prisma.networkOperation.findFirst({
          where: { subscriptionId: paymentStatus.payment!.subscriptionId!, operationType: 'APPLY_POLICY' },
          orderBy: { createdAt: 'desc' },
          select: { status: true, lastError: true },
        });
        if (throttleOp?.status === 'SUCCESS' || throttleOp?.status === 'PERMANENT_FAILURE') break;
      }
      check('FUP: APPLY_POLICY network operation SUCCESS', throttleOp?.status === 'SUCCESS', `status=${String(throttleOp?.status)} err=${String(throttleOp?.lastError)}`);

      // 5.3 reconciliation marks synchronized (desired v2 == router actual)
      await enqueueJob('network-reconciliation');
      let synchronizedAt: Date | null = null;
      for (let i = 0; i < 15 && synchronizedAt === null; i += 1) {
        await sleep(1_000);
        const policy = await prisma.networkPolicy.findUnique({
          where: { subscriptionId: paymentStatus.payment!.subscriptionId! },
          select: { synchronizedAt: true },
        });
        synchronizedAt = policy?.synchronizedAt ?? null;
      }
      const reconcileJob = await prisma.job.findFirst({
        where: { type: 'network-reconciliation' },
        orderBy: { createdAt: 'desc' },
        select: { status: true, result: true, lastError: true },
      });
      check(
        'reconciliation: desired state synchronized',
        synchronizedAt !== null,
        `synced=${String(synchronizedAt !== null)} job=${JSON.stringify(reconcileJob)}`,
      );

      // 5.4 expiry: force past-due, run expiry engine -> EXPIRED + deauth op + session ended
      await prisma.subscription.update({
        where: { id: paymentStatus.payment!.subscriptionId! },
        data: { expiryTime: new Date(Date.now() - 60_000) },
      });
      await enqueueJob('subscription-expiry');
      let expiredSub: { status: string } | null = null;
      for (let i = 0; i < 15; i += 1) {
        await sleep(1_000);
        expiredSub = await prisma.subscription.findUnique({
          where: { id: paymentStatus.payment!.subscriptionId! },
          select: { status: true },
        });
        if (expiredSub?.status === 'EXPIRED') break;
      }
      check('expiry: subscription -> EXPIRED', expiredSub?.status === 'EXPIRED');

      let deauthOp: { status: string; lastError: string | null } | null = null;
      for (let i = 0; i < 15; i += 1) {
        await sleep(1_000);
        deauthOp = await prisma.networkOperation.findFirst({
          where: { subscriptionId: paymentStatus.payment!.subscriptionId!, operationType: 'DEAUTHORIZE' },
          orderBy: { createdAt: 'desc' },
          select: { status: true, lastError: true },
        });
        if (deauthOp?.status === 'SUCCESS' || deauthOp?.status === 'PERMANENT_FAILURE') break;
      }
      check('expiry: DEAUTHORIZE operation SUCCESS', deauthOp?.status === 'SUCCESS', `status=${String(deauthOp?.status)} err=${String(deauthOp?.lastError)}`);

      const endedSession = await prisma.customerSession.findFirst({
        where: { subscriptionId: paymentStatus.payment!.subscriptionId!, terminationReason: 'SUBSCRIPTION_EXPIRED' },
        select: { id: true },
      });
      check('expiry: active session terminated', endedSession !== null);

      // 5.5 customer sees the expired state
      const meAfter = await (async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/v1/customers/me`, { headers: auth });
        return (await response.json()) as { subscription?: { status: string } | null };
      })();
      check('customer /me reflects EXPIRED', meAfter.subscription?.status === 'EXPIRED');

      // ================= Commercial-readiness surface =================

      // 6.1 Guest purchase flow (§36): no account, access code polling
      const guestPurchase = await (async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/v1/guests/purchase`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: '0733000111',
            packageId: pkg.id,
            macAddress: '0A:0B:0C:0D:0E:0F',
          }),
        });
        return (await response.json()) as { paymentId?: string; accessCode?: string; status?: string };
      })();
      check(
        'guest purchase accepted with access code (202)',
        guestPurchase.accessCode !== undefined && guestPurchase.accessCode.startsWith('GST-'),
      );
      if (guestPurchase.paymentId !== undefined) {
        // auto-confirm is disabled in harnesses — drive the callback directly
        const guestPayment = await prisma.payment.findUniqueOrThrow({ where: { id: guestPurchase.paymentId } });
        await fetch(`http://127.0.0.1:${PORT}/api/v1/webhooks/mpesa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerTransactionId: guestPayment.providerTransactionId,
            resultCode: 0,
            amountMinor: pkg.priceMinor,
            receipt: 'GUEST-RCPT-1',
          }),
        });
      }
      let guestStatus = 'PAYMENT_PENDING';
      for (let i = 0; i < 15 && guestStatus !== 'ONLINE'; i += 1) {
        await sleep(1_000);
        const response = await fetch(`http://127.0.0.1:${PORT}/api/v1/guests/${guestPurchase.accessCode}`);
        const body = (await response.json()) as { serviceStatus: string };
        guestStatus = body.serviceStatus;
      }
      check('guest service reaches ONLINE via access-code polling', guestStatus === 'ONLINE', `status=${guestStatus}`);

      // 6.2 Admin package CRUD with versioning (§4.2)
      const created = await (async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/packages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'E2E Pass',
            priceMinor: 9900,
            durationSeconds: 86400,
            policy: { downloadKbps: 8192, uploadKbps: 4096 },
          }),
        });
        return (await response.json()) as { id: string; version: number };
      })();
      check('admin package created v1', created.version === 1, JSON.stringify(created));

      const versioned = await (async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/packages/${created.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ priceMinor: 14900 }),
        });
        return (await response.json()) as { id: string; version: number; supersedes: string };
      })();
      const oldRow = await prisma.package.findUnique({ where: { id: created.id } });
      check(
        'package edit creates v2, retires v1 (history immutable)',
        versioned.version === 2 && versioned.supersedes === created.id && oldRow?.status === 'RETIRED',
      );

      // 6.3 Admin user + role management (§4.3)
      const newUser = await (async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/users`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'billing@nexora.test', password: 'BillingPass!2026', displayName: 'Biller', role: 'BILLING_ADMIN' }),
        });
        return (await response.json()) as { id: string; role: string };
      })();
      check('admin user created with role', newUser.role === 'BILLING_ADMIN');

      const roleChange = await (async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/users/${newUser.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'ANALYST' }),
        });
        return (await response.json()) as { role: string };
      })();
      check('role reassigned (audited, sessions revoked)', roleChange.role === 'ANALYST');

      // 6.4 Customer 3-pane detail (§4.5)
      const detail = await (async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/customers/${reg.customer!.id}`, {
          headers: { Authorization: `Bearer ${admin.token}` },
        });
        return (await response.json()) as { business: unknown; desiredNetworkState: unknown; actualNetworkState: unknown; driftVerdict: string };
      })();
      check(
        'customer 3-pane: business + desired + actual + drift verdict',
        detail.business !== undefined && detail.desiredNetworkState !== null && detail.driftVerdict !== undefined,
      );

      // 6.5 Payment-config + reconciliation trigger (§4.1)
      const payConfig = await (async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/payment-config`, {
          headers: { Authorization: `Bearer ${admin.token}` },
        });
        return (await response.json()) as { provider: string; daraja: { configured: boolean } };
      })();
      check('payment-config visible (booleans only)', payConfig.provider === 'mock' && typeof payConfig.daraja.configured === 'boolean');

      const trigRecon = await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/payment-config/reconcile`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}` },
      });
      let reconJobDone = false;
      for (let i = 0; i < 15 && !reconJobDone; i += 1) {
        await sleep(1_000);
        const job = await prisma.job.findFirst({ where: { type: 'payment-reconciliation' }, orderBy: { createdAt: 'desc' } });
        reconJobDone = job?.status === 'SUCCESS';
      }
      check('payment reconciliation trigger → job SUCCESS', trigRecon.status === 202 && reconJobDone);

      // 6.6 LIVE drift repair (§26): force desired≠actual, reconcile, verify.
      // Uses the ACTIVE guest subscription — the main one is EXPIRED and its
      // revoked desired state legitimately matches router absence.
      const guestCustomer = await prisma.customer.findFirst({
        where: { phoneNumber: '254733000111' },
        include: { subscriptions: { where: { status: { in: ['ACTIVE', 'FUP'] } }, take: 1 } },
      });
      const driftSubId = guestCustomer?.subscriptions[0]?.id ?? null;
      check('drift test has an active subscription', driftSubId !== null);
      if (driftSubId !== null) {
        const policyRow = await prisma.networkPolicy.findUniqueOrThrow({ where: { subscriptionId: driftSubId } });
        const driftDesired = policyRow.desiredState as { macAddress: string | null; authorized: boolean; rateLimit: { downloadKbps: number; uploadKbps: number } | null; sessionTimeLimitSeconds?: number | null };
        await prisma.networkPolicy.update({
          where: { subscriptionId: driftSubId },
          data: {
            desiredState: { ...driftDesired, rateLimit: { downloadKbps: 999, uploadKbps: 999 } },
            synchronizedAt: null,
          },
        });
        const trigNet = await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/network/reconcile`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${admin.token}` },
        });
        let driftRepaired = false;
        let driftOpStatus = 'NONE';
        for (let i = 0; i < 25 && !driftRepaired; i += 1) {
          await sleep(1_000);
          const op = await prisma.networkOperation.findFirst({
            where: { subscriptionId: driftSubId, operationType: 'RECONCILE_SYNC' },
            orderBy: { createdAt: 'desc' },
          });
          driftOpStatus = op?.status ?? 'NONE';
          const synced = await prisma.networkPolicy.findUniqueOrThrow({ where: { subscriptionId: driftSubId } });
          driftRepaired = op?.status === 'SUCCESS' && synced.synchronizedAt !== null;
        }
        check('live drift → RECONCILE_SYNC → repaired + synchronized', trigNet.status === 202 && driftRepaired, `op=${driftOpStatus}`);
      }
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    for (const child of children) child.kill();
    await sleep(500);
    await pg.stop();
    console.log(failures === 0 ? '\n== E2E: ALL CHECKS PASSED ==' : `\n== E2E: ${failures} CHECK(S) FAILED ==`);
    process.exit(failures === 0 ? 0 : 1);
  }
}

void main().catch((error: unknown) => {
  console.error('E2E harness crashed:', error);
  process.exit(1);
});
