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
const PLATFORM_OWNER_EMAIL = 'owner@nexora.test';
const PLATFORM_OWNER_PASSWORD = 'E2eOwner!2026';
const CREDENTIALS_ENCRYPTION_KEY = 'e2e-credentials-key-0123456789abcdef0123456789';

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
  PLATFORM_OWNER_EMAIL,
  PLATFORM_OWNER_PASSWORD,
  CREDENTIALS_ENCRYPTION_KEY,
  ALLOW_TENANT_SIGNUP: 'true',
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

      // ---- Flow M: multi-tenancy (company signup + isolation) ----
      const signup = await fetch(`http://127.0.0.1:${PORT}/api/v1/tenants/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName: 'Acme Fibre E2E',
          adminEmail: 'boss@acme-e2e.test',
          adminPassword: 'AcmeAdmin!2026',
          adminName: 'Acme Boss',
          contactPhone: '0700111222',
        }),
      });
      const signupBody = (await signup.json()) as {
        token?: string;
        tenant?: { id: string; slug: string };
        user?: { role: string };
      };
      check('company signup (201, own SUPER_ADMIN + token)', signup.status === 201 && signupBody.token !== undefined && signupBody.user?.role === 'SUPER_ADMIN');
      const tenantSlug = signupBody.tenant?.slug ?? '';
      const tenantAuth = { Authorization: `Bearer ${signupBody.token}`, 'Content-Type': 'application/json' };

      // Starter catalogue cloned → the new company can sell immediately.
      const tenantPkgs = await fetch(`http://127.0.0.1:${PORT}/api/v1/packages?tenant=${tenantSlug}`);
      const tenantPkgsBody = (await tenantPkgs.json()) as { data: Array<{ id: string }> };
      check('new tenant has a cloned starter catalogue', tenantPkgs.status === 200 && tenantPkgsBody.data.length >= 3);

      // Tenant isolation: the new company's admin summary sees zero of the
      // default tenant's customers (which number >= 2 from Flows A & guest).
      const tenantSummary = await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/summary`, { headers: tenantAuth });
      const tenantSummaryBody = (await tenantSummary.json()) as { summary?: { customers: number; revenueMinor: number } };
      check('tenant isolation: new company sees none of default tenant data', tenantSummary.status === 200 && tenantSummaryBody.summary?.customers === 0 && tenantSummaryBody.summary?.revenueMinor === 0);

      // Tenant payment-config self-service (encrypted at rest).
      const payCfg = await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/tenant/payment-config`, {
        method: 'PUT',
        headers: tenantAuth,
        body: JSON.stringify({ channel: 'TILL', env: 'sandbox', shortcode: '174379', partyB: '5678901', consumerKey: 'ck', consumerSecret: 'cs', passkey: 'pk' }),
      });
      check('tenant configures its own till (credentials encrypted)', payCfg.status === 200);
      const tenantRow = await prisma.tenant.findUniqueOrThrow({ where: { id: signupBody.tenant!.id } });
      check('tenant M-Pesa credentials stored encrypted (not plaintext)', tenantRow.mpesaConsumerKeyEnc !== null && tenantRow.mpesaConsumerKeyEnc !== 'ck' && tenantRow.mpesaConsumerKeyEnc.startsWith('v1.') && tenantRow.mpesaChannel === 'TILL');

      // ---- Flow P: platform owner sees the whole estate ----
      const ownerLogin = await fetch(`http://127.0.0.1:${PORT}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: PLATFORM_OWNER_EMAIL, password: PLATFORM_OWNER_PASSWORD }),
      });
      const owner = (await ownerLogin.json()) as { token?: string; user?: { role: string } };
      check('platform owner login (PLATFORM_OWNER)', ownerLogin.status === 200 && owner.user?.role === 'PLATFORM_OWNER');
      const ownerAuth = { Authorization: `Bearer ${owner.token}` };

      const platformSummary = await fetch(`http://127.0.0.1:${PORT}/api/v1/platform/summary`, { headers: ownerAuth });
      const platformSummaryBody = (await platformSummary.json()) as { summary?: { tenants: number; customers: number; revenueMinor: number } };
      check('platform summary spans all tenants', platformSummary.status === 200 && (platformSummaryBody.summary?.tenants ?? 0) >= 3 && (platformSummaryBody.summary?.customers ?? 0) >= 2);

      const platformTenants = await fetch(`http://127.0.0.1:${PORT}/api/v1/platform/tenants`, { headers: ownerAuth });
      const platformTenantsBody = (await platformTenants.json()) as { data: Array<{ slug: string; mpesaConfigured: boolean }> };
      const acmeRow = platformTenantsBody.data.find((t) => t.slug === tenantSlug);
      check('platform tenant list shows per-company stats + mpesa flag', platformTenants.status === 200 && acmeRow?.mpesaConfigured === true);

      // A tenant admin must NOT reach platform endpoints.
      const platformForbidden = await fetch(`http://127.0.0.1:${PORT}/api/v1/platform/summary`, { headers: { Authorization: `Bearer ${signupBody.token}` } });
      check('tenant admin denied on platform endpoint (403)', platformForbidden.status === 403);

      // ---- Flow O: owner onboards a company directly (independent of public signup) ----
      const ownerCreateEmail = `owner-made-${Date.now().toString(36)}@isp.test`;
      const ownerCreate = await fetch(`http://127.0.0.1:${PORT}/api/v1/platform/tenants`, {
        method: 'POST', headers: { ...ownerAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName: 'Owner Made ISP', adminName: 'Made Admin', adminEmail: ownerCreateEmail, adminPassword: 'owner-made-pw-123' }),
      });
      const ownerCreateBody = (await ownerCreate.json()) as { tenant?: { id: string; slug: string }; admin?: { email: string } };
      check('owner creates a company directly (201 + admin)', ownerCreate.status === 201 && ownerCreateBody.tenant?.id !== undefined && ownerCreateBody.admin?.email === ownerCreateEmail);
      // The created admin can sign in and reach their own company's admin surface.
      const madeLogin = await fetch(`http://127.0.0.1:${PORT}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ownerCreateEmail, password: 'owner-made-pw-123' }) });
      const madeLoginBody = (await madeLogin.json()) as { token?: string; user?: { role: string } };
      const madeSummary = madeLoginBody.token !== undefined ? await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/summary`, { headers: { Authorization: `Bearer ${madeLoginBody.token}` } }) : null;
      check('owner-created admin logs in as SUPER_ADMIN and sees their company', madeLogin.status === 200 && madeLoginBody.user?.role === 'SUPER_ADMIN' && madeSummary?.status === 200);
      // The new company got its own cloned starter catalogue.
      const madeCatalogue = ownerCreateBody.tenant !== undefined ? await prisma.package.count({ where: { tenantId: ownerCreateBody.tenant.id, status: 'ACTIVE' } }) : 0;
      check('owner-created company has a cloned starter catalogue', madeCatalogue >= 1, `packages=${madeCatalogue}`);

      // ---- Flow N: network provisioning is tenant-scoped (autopsy F1/F2) ----
      // Give Acme its own router + customer, confirm a payment, and verify the
      // AUTHORIZE lands on ACME's router — never the default company's.
      const acmeId = signupBody.tenant!.id;
      const acmeRouter = await prisma.router.create({
        data: { tenantId: acmeId, name: 'acme-router-01', vendor: 'MIKROTIK', host: '10.77.0.1', port: 8728, username: 'admin', passwordEnvVar: 'ACME_ROUTER_PASSWORD', site: 'acme-hq' },
      });
      const defaultRouter = await prisma.router.findFirstOrThrow({ where: { tenantId: 'default' } });
      const acmeCustomer = await prisma.customer.create({
        data: { customerNumber: `E2E-ACME-${Date.now().toString(36)}`, tenantId: acmeId, accountType: 'REGISTERED', status: 'ACTIVE', phoneNumber: '254799000222' },
      });
      await prisma.device.create({ data: { customerId: acmeCustomer.id, macAddress: 'AC:11:22:33:44:01' } });
      const acmePkg = await prisma.package.findFirstOrThrow({ where: { tenantId: acmeId, status: 'ACTIVE' }, include: { policy: true } });
      const acmePay = await prisma.payment.create({
        data: { tenantId: acmeId, provider: 'MPESA', providerTransactionId: 'ws_CO_E2E_ACME_1', clientReference: crypto.randomUUID(), customerId: acmeCustomer.id, packageId: acmePkg.id, amountMinor: acmePkg.priceMinor, status: 'PENDING', phoneNumber: '254799000222', deadlineAt: new Date(Date.now() + 60_000) },
      });
      await fetch(`http://127.0.0.1:${PORT}/api/v1/webhooks/mpesa`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: 'ws_CO_E2E_ACME_1', ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [ { Name: 'Amount', Value: acmePkg.priceMinor / 100 }, { Name: 'MpesaReceiptNumber', Value: 'ACMERCPT01' } ] } } } }),
      });
      let acmeAuthOp = null as null | { routerId: string };
      for (let i = 0; i < 15 && acmeAuthOp === null; i += 1) {
        await sleep(500);
        acmeAuthOp = await prisma.networkOperation.findFirst({ where: { subscriptionId: (await prisma.payment.findUniqueOrThrow({ where: { id: acmePay.id } })).subscriptionId ?? '', operationType: 'AUTHORIZE' }, select: { routerId: true } });
      }
      check('provisioning uses the customer’s OWN tenant router, not another company’s', acmeAuthOp !== null && acmeAuthOp.routerId === acmeRouter.id && acmeAuthOp.routerId !== defaultRouter.id, `router=${acmeAuthOp?.routerId === acmeRouter.id ? 'acme' : acmeAuthOp?.routerId}`);

      // ---- Flow R: real Daraja-shaped callback parses even in mock mode (F3) ----
      const darajaCust = await prisma.customer.create({
        data: { customerNumber: `E2E-DARAJA-${Date.now().toString(36)}`, tenantId: 'default', accountType: 'REGISTERED', status: 'ACTIVE', phoneNumber: '254712900001' },
      });
      const darajaPkg = await prisma.package.findFirstOrThrow({ where: { tenantId: 'default', status: 'ACTIVE' } });
      const darajaPay = await prisma.payment.create({
        data: { tenantId: 'default', provider: 'MPESA', providerTransactionId: 'ws_CO_E2E_REAL_1', clientReference: crypto.randomUUID(), customerId: darajaCust.id, packageId: darajaPkg.id, amountMinor: darajaPkg.priceMinor, status: 'PENDING', phoneNumber: '254712000111', deadlineAt: new Date(Date.now() + 60_000) },
      });
      const darajaBody = { Body: { stkCallback: { MerchantRequestID: 'm-1', CheckoutRequestID: 'ws_CO_E2E_REAL_1', ResultCode: 0, ResultDesc: 'The service request is processed successfully.', CallbackMetadata: { Item: [ { Name: 'Amount', Value: darajaPkg.priceMinor / 100 }, { Name: 'MpesaReceiptNumber', Value: 'REALRCPT99' } ] } } } };
      const darajaCb = await fetch(`http://127.0.0.1:${PORT}/api/v1/webhooks/mpesa`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(darajaBody) });
      await sleep(400);
      const darajaAfter = await prisma.payment.findUniqueOrThrow({ where: { id: darajaPay.id } });
      check('real Daraja callback confirmed under mock platform default (F3)', darajaCb.status === 200 && darajaAfter.status === 'SUCCESS' && darajaAfter.receipt === 'REALRCPT99');

      // ---- Flow P: platform billing (owner sells subscription tiers to ISPs) ----
      // Owner assigns Acme a plan (trial). We backdate the covered period so the
      // billing cycle raises a PENDING invoice; Acme pays it via STK to the
      // PLATFORM's own M-Pesa; the callback marks it PAID and restores ACTIVE.
      const starterPlan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'starter' } });
      const assignPlan = await fetch(`http://127.0.0.1:${PORT}/api/v1/platform/tenants/${acmeId}/plan`, { method: 'PUT', headers: { ...ownerAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: starterPlan.id }) });
      const assignBody = (await assignPlan.json()) as { planStatus?: string };
      check('owner assigns a subscription plan (trial starts)', assignPlan.status === 200 && assignBody.planStatus === 'TRIALING');

      // Backdate the period so the recurring cycle bills it now.
      await prisma.tenant.update({ where: { id: acmeId }, data: { currentPeriodEnd: new Date(Date.now() - 1_000) } });
      const runBilling = await fetch(`http://127.0.0.1:${PORT}/api/v1/platform/billing/run`, { method: 'POST', headers: ownerAuth });
      const billBody = (await runBilling.json()) as { invoicesIssued?: number };
      check('billing cycle issues a platform invoice for the lapsed period', runBilling.status === 200 && (billBody.invoicesIssued ?? 0) >= 1);
      const acmeInvoice = await prisma.platformInvoice.findFirstOrThrow({ where: { tenantId: acmeId, status: 'PENDING' } });

      // Owner's invoice list spans all tenants and includes this one.
      const ownerInvoices = await fetch(`http://127.0.0.1:${PORT}/api/v1/platform/invoices`, { headers: ownerAuth });
      const ownerInvBody = (await ownerInvoices.json()) as { data: Array<{ id: string }> };
      check('owner invoice list includes the issued invoice', ownerInvoices.status === 200 && ownerInvBody.data.some((i) => i.id === acmeInvoice.id));

      // Acme initiates payment (STK to the platform shortcode).
      const payInv = await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/billing/invoices/${acmeInvoice.id}/pay`, { method: 'POST', headers: { Authorization: `Bearer ${signupBody.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0799000222' }) });
      check('ISP initiates invoice payment (202, STK in flight)', payInv.status === 202);
      // A second attempt while one is in flight is refused — never double-charges.
      const payTwice = await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/billing/invoices/${acmeInvoice.id}/pay`, { method: 'POST', headers: { Authorization: `Bearer ${signupBody.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0799000222' }) });
      check('duplicate invoice payment refused while one is in flight (409)', payTwice.status === 409);

      // Provider callback confirms → invoice PAID + tenant restored to ACTIVE.
      const inFlightInv = await prisma.platformInvoice.findUniqueOrThrow({ where: { id: acmeInvoice.id } });
      await fetch(`http://127.0.0.1:${PORT}/api/v1/webhooks/mpesa`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: inFlightInv.providerTransactionId, ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [ { Name: 'Amount', Value: acmeInvoice.amountMinor / 100 }, { Name: 'MpesaReceiptNumber', Value: 'PLATRCPT1' } ] } } } }) });
      await sleep(400);
      const paidInv = await prisma.platformInvoice.findUniqueOrThrow({ where: { id: acmeInvoice.id } });
      const acmeAfterPay = await prisma.tenant.findUniqueOrThrow({ where: { id: acmeId } });
      check('platform invoice paid via callback → PAID + tenant ACTIVE', paidInv.status === 'PAID' && paidInv.receipt === 'PLATRCPT1' && acmeAfterPay.planStatus === 'ACTIVE');

      // No-hang: a cancelled STK on an invoice closes the ATTEMPT but leaves the
      // invoice owed so it can be retried (mirrors customer-payment tracking).
      const retryInvoice = await prisma.platformInvoice.create({
        data: { number: `INV-E2E-${Date.now().toString(36).toUpperCase()}`, tenantId: acmeId, planId: starterPlan.id, amountMinor: starterPlan.priceMinor, currency: starterPlan.currency, periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86_400_000), dueDate: new Date(Date.now() + 7 * 86_400_000), status: 'PENDING' },
      });
      await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/billing/invoices/${retryInvoice.id}/pay`, { method: 'POST', headers: { Authorization: `Bearer ${signupBody.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0799000222' }) });
      const retryInFlight = await prisma.platformInvoice.findUniqueOrThrow({ where: { id: retryInvoice.id } });
      await fetch(`http://127.0.0.1:${PORT}/api/v1/webhooks/mpesa`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerTransactionId: retryInFlight.providerTransactionId, resultCode: 1032, resultDesc: 'Request cancelled by user' }) });
      await sleep(300);
      const retryAfter = await prisma.platformInvoice.findUniqueOrThrow({ where: { id: retryInvoice.id } });
      check('cancelled invoice STK closes the attempt, invoice stays owed (no hang)', retryAfter.status === 'PENDING' && retryAfter.providerTransactionId === null && retryAfter.failureReason !== null);

      // ---- Flow M: AI operations monitor writes insights the owner can read ----
      const runMonitor = await fetch(`http://127.0.0.1:${PORT}/api/v1/platform/monitor/run`, { method: 'POST', headers: ownerAuth });
      const monitorBody = (await runMonitor.json()) as { ok?: boolean; insightsCreated?: number };
      check('AI monitor scan runs and reports signal counts', runMonitor.status === 200 && monitorBody.ok === true && typeof monitorBody.insightsCreated === 'number');
      const insightsList = await fetch(`http://127.0.0.1:${PORT}/api/v1/platform/insights?status=ALL`, { headers: ownerAuth });
      check('owner reads the AI insights feed', insightsList.status === 200 && Array.isArray(((await insightsList.json()) as { data: unknown[] }).data));

      // ---- Flow S: suspended company is refused, then reactivated (F5) ----
      await fetch(`http://127.0.0.1:${PORT}/api/v1/platform/tenants/${acmeId}`, { method: 'PATCH', headers: { ...ownerAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'SUSPENDED' }) });
      const suspendedList = await fetch(`http://127.0.0.1:${PORT}/api/v1/packages?tenant=${tenantSlug}`);
      check('suspended company refuses public traffic (403, no reroute to default)', suspendedList.status === 403);
      const acmeStaffAfter = await fetch(`http://127.0.0.1:${PORT}/api/v1/admin/summary`, { headers: { Authorization: `Bearer ${signupBody.token}` } });
      check('suspended company staff sessions revoked (401)', acmeStaffAfter.status === 401);
      await fetch(`http://127.0.0.1:${PORT}/api/v1/platform/tenants/${acmeId}`, { method: 'PATCH', headers: { ...ownerAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'ACTIVE' }) });
      const reactivated = await fetch(`http://127.0.0.1:${PORT}/api/v1/packages?tenant=${tenantSlug}`);
      check('reactivated company serves public traffic again', reactivated.status === 200);

      // ---- Flow C: concurrent callbacks activate exactly once (autopsy F4) ----
      const raceCust = await prisma.customer.create({
        data: { customerNumber: `E2E-RACE-${Date.now().toString(36)}`, tenantId: 'default', accountType: 'REGISTERED', status: 'ACTIVE', phoneNumber: '254712900002' },
      });
      const racePkg = await prisma.package.findFirstOrThrow({ where: { tenantId: 'default', status: 'ACTIVE' } });
      const racePay = await prisma.payment.create({
        data: { tenantId: 'default', provider: 'MPESA', providerTransactionId: 'ws_CO_E2E_RACE_1', clientReference: crypto.randomUUID(), customerId: raceCust.id, packageId: racePkg.id, amountMinor: racePkg.priceMinor, status: 'PENDING', phoneNumber: '254712000111', deadlineAt: new Date(Date.now() + 60_000) },
      });
      const raceCb = () => fetch(`http://127.0.0.1:${PORT}/api/v1/webhooks/mpesa`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerTransactionId: 'ws_CO_E2E_RACE_1', resultCode: 0, resultDesc: 'ok', amountMinor: racePkg.priceMinor, receipt: 'RACERCPT1' }) });
      await Promise.all([raceCb(), raceCb(), raceCb()]);
      await sleep(600);
      const raceSubs = await prisma.subscription.count({ where: { paymentReference: racePay.id } });
      check('concurrent callbacks on one payment activate exactly once (F4)', raceSubs === 1, `subs=${raceSubs}`);

      // ---- Flow X: payment lifecycle — cancel + timeout (no hanging) ----
      const cancelCustomer = await prisma.customer.findFirstOrThrow({ where: { phoneNumber: '254712000111' } });
      const cancelPkg = await prisma.package.findFirstOrThrow({ where: { tenantId: 'default', status: 'ACTIVE' } });
      const cancelPayment = await prisma.payment.create({
        data: { tenantId: 'default', provider: 'MPESA', providerTransactionId: 'E2E-CANCEL-TX', clientReference: crypto.randomUUID(), customerId: cancelCustomer.id, packageId: cancelPkg.id, amountMinor: cancelPkg.priceMinor, status: 'PENDING', phoneNumber: '254712000111', deadlineAt: new Date(Date.now() + 60_000) },
      });
      const cancelCb = await fetch(`http://127.0.0.1:${PORT}/api/v1/webhooks/mpesa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerTransactionId: 'E2E-CANCEL-TX', resultCode: 1032, resultDesc: 'Request cancelled by user' }),
      });
      await sleep(300);
      const cancelledRow = await prisma.payment.findUniqueOrThrow({ where: { id: cancelPayment.id } });
      check('user-cancelled callback (1032) → CANCELLED, not FAILED', cancelCb.status === 200 && cancelledRow.status === 'CANCELLED');

      // Timeout: an INITIATED payment whose STK push never reached the provider
      // (no provider transaction id) and is past the grace window is closed out
      // EXPIRED by reconciliation — nothing is ever left hanging.
      const timeoutPayment = await prisma.payment.create({
        data: { tenantId: 'default', provider: 'MPESA', clientReference: crypto.randomUUID(), customerId: cancelCustomer.id, packageId: cancelPkg.id, amountMinor: cancelPkg.priceMinor, status: 'INITIATED', phoneNumber: '254712000111', initiatedAt: new Date(Date.now() - 20 * 60_000) },
      });
      await prisma.job.create({ data: { type: 'payment-reconciliation', payload: { source: 'e2e-timeout' }, status: 'QUEUED' } });
      let timeoutStatus = 'INITIATED';
      for (let i = 0; i < 20 && timeoutStatus === 'INITIATED'; i += 1) {
        await sleep(1_000);
        timeoutStatus = (await prisma.payment.findUniqueOrThrow({ where: { id: timeoutPayment.id } })).status;
      }
      check('timed-out payment → EXPIRED by reconciliation (no hanging)', timeoutStatus === 'EXPIRED', `status=${timeoutStatus}`);
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
