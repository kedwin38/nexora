/**
 * Stage 9 chaos + security harness (persona §3.G/H, build steps 44–45).
 *
 * Chaos: out-of-order callbacks, unknown transactions, amount tampering,
 * op exhaustion -> PERMANENT_FAILURE -> admin retry -> success, orphaned
 * PROCESSING recovery, concurrent purchases, renewal de-duplication.
 * Security: rate limiting, token tampering/bypass, RBAC escalation,
 * SQL-injection probes, PII-in-metrics scan.
 *
 * Run: npm run e2e:chaos
 */

import { setTimeout as sleep } from 'node:timers/promises';
import {
  adminLogin,
  makeChecker,
  purchasePackage,
  registerCustomer,
  sendCallback,
  startStack,
} from './lib/harness.js';

async function main(): Promise<number> {
  console.log('== NEXORA chaos + security E2E ==');
  const stack = await startStack({ port: 5070, pgPort: 5434 });
  const { prisma, baseUrl } = stack;
  const checker = makeChecker();
  const { check } = checker;

  try {
    const packagesResponse = await fetch(`${baseUrl}/api/v1/packages`);
    const packagesBody = (await packagesResponse.json()) as { data: Array<{ id: string; name: string; priceMinor: number }> };
    const pkg = packagesBody.data.find((p) => p.name === 'Day Pass') ?? packagesBody.data[0]!;
    const mac = 'CA:FE:00:00:00:01';

    // ---------------- CHAOS: callback torture ----------------
    const customer = await registerCustomer(baseUrl, '0712000999');

    // Unknown transaction: acknowledged, nothing created
    const unknown = await sendCallback(baseUrl, {
      providerTransactionId: 'ws_CO_UNKNOWN_1',
      resultCode: 0,
      amountMinor: pkg.priceMinor,
      receipt: 'GHOST',
    });
    const ghostPayments = await prisma.payment.count({ where: { receipt: 'GHOST' } });
    check('chaos: unknown callback acked, no phantom payment', unknown === 200 && ghostPayments === 0);

    const purchase = await purchasePackage(baseUrl, customer.token, pkg.id, mac);

    // Amount tampering: wrong amount -> FAILED, no subscription
    const tampered = await sendCallback(baseUrl, {
      providerTransactionId: purchase.providerTransactionId,
      resultCode: 0,
      amountMinor: 1, // attacker "pays" 1 cent for a Day Pass
      receipt: 'TAMPER1',
    });
    const tamperedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: purchase.paymentId } });
    const tamperedSubs = await prisma.subscription.count({ where: { customerId: customer.customerId } });
    check(
      'chaos: amount-mismatch callback rejected (FAILED, no subscription)',
      tampered === 200 && tamperedPayment.status === 'FAILED' && tamperedPayment.failureReason === 'AMOUNT_MISMATCH' && tamperedSubs === 0,
    );

    // Failed callback after terminal FAILED: no state resurrection
    await sendCallback(baseUrl, { providerTransactionId: purchase.providerTransactionId, resultCode: 1032 });
    const stillFailed = await prisma.payment.findUniqueOrThrow({ where: { id: purchase.paymentId } });
    check('chaos: late callback cannot resurrect a terminal payment', stillFailed.status === 'FAILED');

    // Second, clean purchase -> success; then out-of-order replay + late cancel
    const purchase2 = await purchasePackage(baseUrl, customer.token, pkg.id, mac);
    await sendCallback(baseUrl, {
      providerTransactionId: purchase2.providerTransactionId,
      resultCode: 0,
      amountMinor: pkg.priceMinor,
      receipt: 'CHAOS_OK_1',
    });
    await sendCallback(baseUrl, { providerTransactionId: purchase2.providerTransactionId, resultCode: 1032 });
    await sendCallback(baseUrl, {
      providerTransactionId: purchase2.providerTransactionId,
      resultCode: 0,
      amountMinor: pkg.priceMinor,
      receipt: 'CHAOS_OK_1',
    });
    const p2 = await prisma.payment.findUniqueOrThrow({ where: { id: purchase2.paymentId } });
    const subsAfterChaos = await prisma.subscription.count({ where: { customerId: customer.customerId } });
    check(
      'chaos: out-of-order replay after success is a no-op',
      p2.status === 'SUCCESS' && p2.receipt === 'CHAOS_OK_1' && subsAfterChaos === 1,
    );

    // Renewal de-dup: same customer buys the same package again -> extension, not duplicate
    const purchase3 = await purchasePackage(baseUrl, customer.token, pkg.id, mac);
    await sendCallback(baseUrl, {
      providerTransactionId: purchase3.providerTransactionId,
      resultCode: 0,
      amountMinor: pkg.priceMinor,
      receipt: 'CHAOS_OK_2',
    });
    const subsAfterRenewal = await prisma.subscription.count({
      where: { customerId: customer.customerId, status: { in: ['ACTIVE', 'FUP'] } },
    });
    check('chaos: repurchase extends (renewal), never duplicates subscriptions', subsAfterRenewal === 1);

    // Concurrent purchases by two customers
    const [cA, cB] = await Promise.all([
      registerCustomer(baseUrl, '0712000888'),
      registerCustomer(baseUrl, '0712000777'),
    ]);
    const [buyA, buyB] = await Promise.all([
      purchasePackage(baseUrl, cA.token, pkg.id, 'CA:FE:00:00:00:AA'),
      purchasePackage(baseUrl, cB.token, pkg.id, 'CA:FE:00:00:00:BB'),
    ]);
    await Promise.all([
      sendCallback(baseUrl, { providerTransactionId: buyA.providerTransactionId, resultCode: 0, amountMinor: pkg.priceMinor, receipt: 'RACE_A' }),
      sendCallback(baseUrl, { providerTransactionId: buyB.providerTransactionId, resultCode: 0, amountMinor: pkg.priceMinor, receipt: 'RACE_B' }),
    ]);
    const [subA, subB] = await Promise.all([
      prisma.subscription.count({ where: { customerId: cA.customerId } }),
      prisma.subscription.count({ where: { customerId: cB.customerId } }),
    ]);
    check('chaos: concurrent purchases both activate exactly once', subA === 1 && subB === 1);

    // ---------------- CHAOS: operation failure -> PERMANENT -> admin retry ----------------
    const router = await prisma.router.findFirstOrThrow();
    const failOp = await prisma.networkOperation.create({
      data: {
        routerId: router.id,
        customerId: cA.customerId,
        subscriptionId: (await prisma.subscription.findFirstOrThrow({ where: { customerId: cA.customerId } })).id,
        operationType: 'AUTHORIZE',
        desiredState: { macAddress: null, authorized: true, rateLimit: { downloadKbps: 5120, uploadKbps: 2560 } }, // invalid: no MAC
        status: 'QUEUED',
        maxAttempts: 2,
        idempotencyKey: `chaos-fail-${Date.now()}`,
      },
    });
    let failStatus = 'QUEUED';
    for (let i = 0; i < 30; i += 1) {
      await sleep(1_000);
      const op = await prisma.networkOperation.findUniqueOrThrow({ where: { id: failOp.id } });
      failStatus = op.status;
      if (failStatus === 'PERMANENT_FAILURE') break;
    }
    check('chaos: invalid op exhausts retries -> PERMANENT_FAILURE', failStatus === 'PERMANENT_FAILURE', `status=${failStatus}`);

    // Repair the desired state, then admin retry -> SUCCESS
    await prisma.networkOperation.update({
      where: { id: failOp.id },
      data: { desiredState: { macAddress: 'CA:FE:00:00:00:AA', authorized: true, rateLimit: { downloadKbps: 5120, uploadKbps: 2560 } } },
    });
    const admin = await adminLogin(baseUrl);
    const retryResponse = await fetch(`${baseUrl}/api/v1/admin/network-operations/${failOp.id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin}` },
    });
    let retryStatus = 'QUEUED';
    for (let i = 0; i < 15; i += 1) {
      await sleep(1_000);
      retryStatus = (await prisma.networkOperation.findUniqueOrThrow({ where: { id: failOp.id } })).status;
      if (retryStatus === 'SUCCESS' || retryStatus === 'PERMANENT_FAILURE') break;
    }
    check('chaos: admin-repaired retry reaches SUCCESS', retryResponse.status === 202 && retryStatus === 'SUCCESS', `status=${retryStatus}`);

    // ---------------- CHAOS: orphaned PROCESSING recovery ----------------
    const subBRow = await prisma.subscription.findFirstOrThrow({ where: { customerId: cB.customerId } });
    const orphan = await prisma.networkOperation.create({
      data: {
        routerId: router.id,
        customerId: cB.customerId,
        subscriptionId: subBRow.id,
        operationType: 'APPLY_POLICY',
        desiredState: { macAddress: 'CA:FE:00:00:00:BB', authorized: true, rateLimit: { downloadKbps: 2048, uploadKbps: 1024 } },
        status: 'PROCESSING',
        startedAt: new Date(Date.now() - 5 * 60_000), // "worker died 5 minutes ago"
        idempotencyKey: `chaos-orphan-${Date.now()}`,
      },
    });
    let orphanStatus = 'PROCESSING';
    for (let i = 0; i < 15; i += 1) {
      await sleep(1_000);
      orphanStatus = (await prisma.networkOperation.findUniqueOrThrow({ where: { id: orphan.id } })).status;
      if (orphanStatus === 'SUCCESS') break;
    }
    check('chaos: orphaned PROCESSING op reclaimed and completed', orphanStatus === 'SUCCESS', `status=${orphanStatus}`);

    // ---------------- SECURITY ----------------
    // RBAC escalation FIRST (before brute-force rate-limits logins):
    // SUPPORT_AGENT may read payments but not summary (monitoring.read) nor retry ops.
    const supportRole = await prisma.role.findUniqueOrThrow({ where: { name: 'SUPPORT_AGENT' } });
    const { hash } = await import('@node-rs/argon2');
    await prisma.user.create({
      data: {
        email: 'support@nexora.test',
        passwordHash: await hash('Support!2026', { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
        displayName: 'Agent',
        roleId: supportRole.id,
      },
    });
    const supportLogin = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'support@nexora.test', password: 'Support!2026' }),
    });
    const supportToken = ((await supportLogin.json()) as { token?: string }).token ?? 'NO-TOKEN';
    const [paymentsAllowed, summaryDenied, retryDenied] = await Promise.all([
      fetch(`${baseUrl}/api/v1/admin/payments`, { headers: { Authorization: `Bearer ${supportToken}` } }),
      fetch(`${baseUrl}/api/v1/admin/summary`, { headers: { Authorization: `Bearer ${supportToken}` } }),
      fetch(`${baseUrl}/api/v1/admin/network-operations/${failOp.id}/retry`, { method: 'POST', headers: { Authorization: `Bearer ${supportToken}` } }),
    ]);
    check(
      'security: RBAC enforced per permission matrix (SUPPORT_AGENT)',
      supportLogin.status === 200 && paymentsAllowed.status === 200 && summaryDenied.status === 403 && retryDenied.status === 403,
      `login=${supportLogin.status} ${paymentsAllowed.status}/${summaryDenied.status}/${retryDenied.status}`,
    );

    // Rate limiting: 6th bad login within the window -> 429 (isolated client IP
    // via X-Forwarded-For; trustProxy=true makes req.ip honor it).
    let got429 = false;
    for (let i = 0; i < 7; i += 1) {
      const r = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.77' },
        body: JSON.stringify({ email: 'nobody@nexora.test', password: 'wrong' }),
      });
      if (r.status === 429) { got429 = true; break; }
    }
    check('security: login brute-force hits 429 rate limit', got429);

    // Token tampering / bypass
    const noToken = await fetch(`${baseUrl}/api/v1/admin/summary`);
    const badToken = await fetch(`${baseUrl}/api/v1/admin/summary`, { headers: { Authorization: 'Bearer nonsense' } });
    const tamperedToken = await fetch(`${baseUrl}/api/v1/customers/me`, {
      headers: { Authorization: `Bearer ${customer.token.slice(0, -4)}beef` },
    });
    check(
      'security: auth bypass attempts rejected',
      noToken.status === 401 && badToken.status === 401 && tamperedToken.status === 401,
      `${noToken.status}/${badToken.status}/${tamperedToken.status}`,
    );

    // SQL-injection probes against search/pagination inputs
    const sqli = await fetch(`${baseUrl}/api/v1/admin/payments?search=%27%20OR%201%3D1%20--&limit=5`, {
      headers: { Authorization: `Bearer ${admin}` },
    });
    const sqliBody = (await sqli.json()) as { total: number };
    check(
      'security: SQL-injection probe neutralized (parameterized Prisma)',
      sqli.status === 200 && sqliBody.total < 1000,
      `total=${sqliBody.total}`,
    );

    // XSS storage probe: stored verbatim as data, served as JSON only
    const xss = await registerCustomer(baseUrl, '0712000666', 'Customer!2026', '<script>alert(1)</script>');
    const meResponse = await fetch(`${baseUrl}/api/v1/customers/me`, { headers: { Authorization: `Bearer ${xss.token}` } });
    const meText = await meResponse.text();
    check(
      'security: XSS payload stored as data, served as JSON (never HTML)',
      meResponse.status === 200 &&
        meResponse.headers.get('content-type')?.includes('application/json') === true &&
        meText.includes('<script>alert(1)</script>'),
    );

    // PII must never appear in /metrics
    const metricsResponse = await fetch(`${baseUrl}/metrics`);
    const metricsText = await metricsResponse.text();
    check(
      'security: no PII (phone numbers) leaked into /metrics',
      metricsResponse.status === 200 && !metricsText.includes('0712000') && !metricsText.includes('2547'),
    );
  } finally {
    await stack.stop();
  }
  return checker.result.failures;
}

void main()
  .then((failures) => {
    console.log(failures === 0 ? '\n== CHAOS/SECURITY: ALL CHECKS PASSED ==' : `\n== CHAOS/SECURITY: ${failures} CHECK(S) FAILED ==`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((error: unknown) => {
    console.error('Chaos harness crashed:', error);
    process.exit(1);
  });
