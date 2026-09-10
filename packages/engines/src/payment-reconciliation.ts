/**
 * Payment reconciliation & timeout closure (§16, §75).
 *
 * The invariant this enforces: **no payment is ever left hanging.** Every
 * payment reaches a terminal state — SUCCESS, FAILED, CANCELLED or EXPIRED —
 * either from a webhook callback or from this sweep. Three cases are handled:
 *
 *   1. INITIATED with no provider transaction id, older than the initiate
 *      grace window → the STK push never reached Safaricom (process died
 *      mid-flight). Marked EXPIRED.
 *   2. PENDING with a provider transaction id, stale → the provider is
 *      queried. SUCCESS activates through the standard activation transaction;
 *      a terminal failure is classified as CANCELLED / EXPIRED / FAILED.
 *   3. PENDING past its hard deadline that the provider still cannot resolve
 *      (still processing, or provider unreachable) → EXPIRED, so it cannot
 *      wait forever.
 *
 * Financial operations are never blindly retried — we only ever read provider
 * state and then record a terminal transition.
 */

import type { PrismaClient } from '@prisma/client';
import type { PaymentProvider } from '@nexora/payment-sdk';
import { activateOnPaymentSuccess } from './activation.js';

/** Resolve the provider to query for a given payment (per-tenant credentials). */
export type PaymentProviderResolver = (payment: {
  tenantId: string;
  provider: string;
}) => Promise<PaymentProvider | null>;

const STALE_AFTER_MS = 3 * 60_000; // don't query before the STK prompt could plausibly resolve
const INITIATED_GRACE_MS = 5 * 60_000; // an INITIATED payment with no provider id is dead after this
const HARD_TIMEOUT_MS = 15 * 60_000; // absolute ceiling for any PENDING payment

export interface PaymentReconciliationResult {
  readonly checked: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly expired: number;
  readonly stillPending: number;
  readonly providerErrors: number;
}

function isProvider(x: PaymentProvider | PaymentProviderResolver): x is PaymentProvider {
  return typeof (x as PaymentProvider).queryTransaction === 'function';
}

async function closeOut(
  prisma: PrismaClient,
  paymentId: string,
  status: 'FAILED' | 'CANCELLED' | 'EXPIRED',
  reason: string,
  now: Date,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.payment.findUnique({ where: { id: paymentId } });
    if (fresh === null || (fresh.status !== 'PENDING' && fresh.status !== 'INITIATED')) return;
    await tx.payment.update({
      where: { id: paymentId },
      data: { status, failureReason: reason.slice(0, 500), completedAt: now },
    });
    await tx.paymentAttempt.create({
      data: { paymentId, attemptType: 'STATUS_QUERY', resultDesc: reason.slice(0, 200) },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: status === 'CANCELLED' ? 'PAYMENT_CANCELLED' : status === 'EXPIRED' ? 'PAYMENT_EXPIRED' : 'PAYMENT_FAILED',
        aggregateType: 'Payment',
        aggregateId: paymentId,
        payload: { paymentId, reason, status },
        correlationId: `recon-${paymentId}`,
      },
    });
  });
}

export async function runPaymentReconciliation(
  prisma: PrismaClient,
  providerOrResolver: PaymentProvider | PaymentProviderResolver,
  now: Date = new Date(),
): Promise<PaymentReconciliationResult> {
  const resolve: PaymentProviderResolver = isProvider(providerOrResolver)
    ? async () => providerOrResolver
    : providerOrResolver;

  let confirmed = 0;
  let failed = 0;
  let cancelled = 0;
  let expired = 0;
  let stillPending = 0;
  let providerErrors = 0;

  // --- Case 1: INITIATED that never got a provider transaction id ---
  const orphaned = await prisma.payment.findMany({
    where: {
      status: 'INITIATED',
      providerTransactionId: null,
      initiatedAt: { lt: new Date(now.getTime() - INITIATED_GRACE_MS) },
    },
    take: 50,
  });
  for (const payment of orphaned) {
    await closeOut(prisma, payment.id, 'EXPIRED', 'STK push never confirmed by provider', now);
    expired += 1;
  }

  // --- Cases 2 & 3: PENDING with a provider transaction id ---
  const stale = await prisma.payment.findMany({
    where: {
      status: 'PENDING',
      initiatedAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) },
      providerTransactionId: { not: null },
    },
    include: { package: { include: { policy: true } } },
    take: 50,
  });

  for (const payment of stale) {
    if (payment.providerTransactionId === null) continue;
    const pastHardDeadline =
      (payment.deadlineAt !== null && payment.deadlineAt.getTime() <= now.getTime()) ||
      payment.initiatedAt.getTime() <= now.getTime() - HARD_TIMEOUT_MS;

    let provider: PaymentProvider | null;
    try {
      provider = await resolve({ tenantId: payment.tenantId, provider: payment.provider });
    } catch {
      provider = null;
    }
    if (provider === null) {
      // Cannot query (tenant creds gone / provider down). Never hang forever.
      if (pastHardDeadline) {
        await closeOut(prisma, payment.id, 'EXPIRED', 'Unresolvable past hard deadline', now);
        expired += 1;
      } else {
        providerErrors += 1;
      }
      continue;
    }

    try {
      const result = await provider.queryTransaction(payment.providerTransactionId);
      if (result.status === 'SUCCESS') {
        await activateOnPaymentSuccess(prisma, {
          payment,
          receipt: result.receipt ?? payment.providerTransactionId,
          correlationId: `recon-${payment.id}`,
        });
        confirmed += 1;
      } else if (result.status === 'PENDING') {
        if (pastHardDeadline) {
          await closeOut(prisma, payment.id, 'EXPIRED', 'Timed out — provider still processing past deadline', now);
          expired += 1;
        } else {
          stillPending += 1;
        }
      } else {
        // Terminal failure — classify.
        const outcome = result.outcome ?? 'FAILED';
        const status = outcome === 'CANCELLED' ? 'CANCELLED' : outcome === 'TIMEOUT' ? 'EXPIRED' : 'FAILED';
        await closeOut(prisma, payment.id, status, `RECONCILED: ${result.reason}`, now);
        if (status === 'CANCELLED') cancelled += 1;
        else if (status === 'EXPIRED') expired += 1;
        else failed += 1;
      }
    } catch {
      if (pastHardDeadline) {
        await closeOut(prisma, payment.id, 'EXPIRED', 'Provider query failed past hard deadline', now);
        expired += 1;
      } else {
        providerErrors += 1; // leave for the next cycle
      }
    }
  }

  return {
    checked: orphaned.length + stale.length,
    confirmed,
    failed,
    cancelled,
    expired,
    stillPending,
    providerErrors,
  };
}
