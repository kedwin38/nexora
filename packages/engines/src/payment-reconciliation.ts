/**
 * Payment reconciliation (§75): stale PENDING payments are queried against
 * the provider and resolved — SUCCESS activates through the standard
 * activation transaction; FAILED is recorded; still-PENDING waits for the
 * next cycle. Never blindly retries non-idempotent financial operations.
 */

import type { PrismaClient } from '@prisma/client';
import type { PaymentProvider } from '@nexora/payment-sdk';
import { activateOnPaymentSuccess } from './activation.js';

const STALE_AFTER_MS = 5 * 60_000;

export interface PaymentReconciliationResult {
  readonly checked: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly stillPending: number;
  readonly providerErrors: number;
}

export async function runPaymentReconciliation(
  prisma: PrismaClient,
  provider: PaymentProvider,
  now: Date = new Date(),
): Promise<PaymentReconciliationResult> {
  const stale = await prisma.payment.findMany({
    where: {
      status: 'PENDING',
      initiatedAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) },
      providerTransactionId: { not: null },
    },
    include: { package: { include: { policy: true } } },
    take: 50,
  });

  let confirmed = 0;
  let failed = 0;
  let stillPending = 0;
  let providerErrors = 0;

  for (const payment of stale) {
    if (payment.providerTransactionId === null) continue;
    try {
      const result = await provider.queryTransaction(payment.providerTransactionId);
      if (result.status === 'PENDING') {
        stillPending += 1;
        continue;
      }
      if (result.status === 'SUCCESS') {
        await activateOnPaymentSuccess(prisma, {
          payment,
          receipt: result.receipt ?? payment.providerTransactionId,
          correlationId: `recon-${payment.id}`,
        });
        confirmed += 1;
      } else {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED', failureReason: `RECONCILED: ${result.reason}`.slice(0, 500), completedAt: now },
        });
        await prisma.outboxEvent.create({
          data: {
            eventType: 'PAYMENT_FAILED',
            aggregateType: 'Payment',
            aggregateId: payment.id,
            payload: { paymentId: payment.id, reason: 'RECONCILED_TIMEOUT' },
            correlationId: `recon-${payment.id}`,
          },
        });
        failed += 1;
      }
    } catch {
      providerErrors += 1; // leave for the next cycle
    }
  }

  return { checked: stale.length, confirmed, failed, stillPending, providerErrors };
}
