/**
 * Payment activation (§48): the single transaction that converts a
 * successful payment into service — Subscription (immutable policy
 * snapshot), FUP state, desired network state, AUTHORIZE operation, outbox
 * events and audit. Owned here (domain logic) and consumed by the API
 * webhook route and payment reconciliation alike.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { paymentMachine, subscriptionMachine } from '@nexora/domain';

export type PaymentWithPackage = Prisma.PaymentGetPayload<{
  include: { package: { include: { policy: true } } };
}>;

export interface ActivationHooks {
  onConfirmed?: (input: { paymentId: string }) => void;
}

export async function activateOnPaymentSuccess(
  prisma: PrismaClient,
  input: {
    payment: PaymentWithPackage;
    receipt: string;
    correlationId: string;
  },
  hooks?: ActivationHooks,
): Promise<{ id: string; outcome: 'ACTIVATED' | 'RENEWED' }> {
  const { package: pkg } = input.payment;
  if (pkg === null) {
    throw new Error(`Payment ${input.payment.id} has no package — cannot activate.`);
  }
  const paymentId = input.payment.id;
  const customerId = input.payment.customerId;
  const now = new Date();
  const expiry = new Date(now.getTime() + pkg.durationSeconds * 1000);

  const policySnapshot = {
    downloadKbps: pkg.policy?.downloadKbps ?? 2048,
    uploadKbps: pkg.policy?.uploadKbps ?? 1024,
    burstDownloadKbps: pkg.policy?.burstDownloadKbps ?? null,
    burstUploadKbps: pkg.policy?.burstUploadKbps ?? null,
    fupLimitBytes: pkg.policy?.fupLimitBytes?.toString() ?? null,
    fupWarningPercent: pkg.policy?.fupWarningPercent ?? 80,
    fupThrottleDownloadKbps: pkg.policy?.fupThrottleDownloadKbps ?? null,
    fupThrottleUploadKbps: pkg.policy?.fupThrottleUploadKbps ?? null,
    sessionTimeLimitSeconds: pkg.policy?.sessionTimeLimitSeconds ?? null,
  };
  const rateLimit = { downloadKbps: policySnapshot.downloadKbps, uploadKbps: policySnapshot.uploadKbps };

  return await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    paymentMachine.assertTransition(payment.status, 'SUCCESS');

    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'SUCCESS', receipt: input.receipt, completedAt: now },
    });
    await tx.paymentAttempt.create({
      data: {
        paymentId: payment.id,
        attemptType: 'CALLBACK',
        responsePayload: { receipt: input.receipt },
        resultCode: '0',
      },
    });

    const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });

    // One active/pending subscription per customer purchase; extend if an
    // active sub exists for the same package (renewal semantics).
    const existingSub = await tx.subscription.findFirst({
      where: { customerId: customerId, status: { in: ['ACTIVE', 'FUP', 'PENDING', 'PROVISIONING'] } },
      orderBy: { createdAt: 'desc' },
    });

    let subscriptionId: string;
    let outcome: 'ACTIVATED' | 'RENEWED';

    if (existingSub !== null && existingSub.packageId === pkg.id) {
      subscriptionMachine.assertTransition(existingSub.status, 'ACTIVE');
      const extendedExpiry = new Date(
        Math.max(existingSub.expiryTime?.getTime() ?? 0, now.getTime()) + pkg.durationSeconds * 1000,
      );
      await tx.subscription.update({
        where: { id: existingSub.id },
        data: { status: 'ACTIVE', expiryTime: extendedExpiry },
      });
      await tx.payment.update({ where: { id: payment.id }, data: { subscriptionId: existingSub.id } });
      subscriptionId = existingSub.id;
      outcome = 'RENEWED';
    } else {
      const created = await tx.subscription.create({
        data: {
          subscriptionNumber: `SUB-${now.getTime().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          customerId: customerId,
          packageId: pkg.id,
          packageVersion: pkg.version,
          status: 'ACTIVE',
          startTime: now,
          expiryTime: expiry,
          billingPeriodStart: now,
          billingPeriodEnd: expiry,
          priceAtPurchaseMinor: pkg.priceMinor,
          fupThresholdAtPurchaseBytes: pkg.policy?.fupLimitBytes ?? null,
          policySnapshot,
          paymentReference: payment.id,
        },
      });
      await tx.payment.update({ where: { id: payment.id }, data: { subscriptionId: created.id } });

      if (pkg.policy?.fupLimitBytes != null) {
        await tx.fupState.create({
          data: {
            subscriptionId: created.id,
            state: 'NORMAL',
            usedBytes: 0n,
            limitBytes: pkg.policy.fupLimitBytes,
            warningPercent: pkg.policy.fupWarningPercent,
            periodStart: now,
            periodEnd: expiry,
          },
        });
      }

      // Default router + purchasing device for Phase 1 (single-router deployments).
      const router = await tx.router.findFirst({ where: { status: { not: 'OFFLINE' } }, orderBy: { createdAt: 'asc' } });
      const device = await tx.device.findFirst({
        where: { customerId: customerId },
        orderBy: { lastSeenAt: 'desc' },
      });

      await tx.networkPolicy.create({
        data: {
          subscriptionId: created.id,
          desiredState: {
            macAddress: device?.macAddress ?? null,
            authorized: true,
            rateLimit,
            sessionTimeLimitSeconds: policySnapshot.sessionTimeLimitSeconds,
          },
          version: 1,
        },
      });

      if (router !== null) {
        await tx.networkOperation.create({
          data: {
            routerId: router.id,
            customerId: customerId,
            subscriptionId: created.id,
            operationType: 'AUTHORIZE',
            desiredState: {
              macAddress: device?.macAddress ?? null,
              authorized: true,
              rateLimit,
              sessionTimeLimitSeconds: policySnapshot.sessionTimeLimitSeconds,
            },
            status: 'QUEUED',
            idempotencyKey: `authorize:${created.id}:v1`,
            correlationId: input.correlationId,
          },
        });
      }

      subscriptionId = created.id;
      outcome = 'ACTIVATED';
    }

    if (customer.status === 'PENDING') {
      await tx.customer.update({ where: { id: customer.id }, data: { status: 'ACTIVE' } });
    }

    for (const [eventType, payload] of [
      ['PAYMENT_CONFIRMED', { paymentId: payment.id, receipt: input.receipt, amountMinor: payment.amountMinor }],
      [outcome === 'RENEWED' ? 'SUBSCRIPTION_RENEWED' : 'SUBSCRIPTION_ACTIVATED', { subscriptionId }],
      ['NETWORK_PROVISION_REQUESTED', { subscriptionId }],
    ] as const) {
      await tx.outboxEvent.create({
        data: {
          eventType,
          aggregateType: eventType.startsWith('PAYMENT') ? 'Payment' : 'Subscription',
          aggregateId: eventType.startsWith('PAYMENT') ? payment.id : subscriptionId,
          payload: payload as object,
          correlationId: input.correlationId,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        actorType: 'SYSTEM',
        action: 'PAYMENT_CONFIRMED',
        resourceType: 'Payment',
        resourceId: payment.id,
        beforeState: { status: payment.status },
        afterState: { status: 'SUCCESS', subscriptionId },
        correlationId: input.correlationId,
      },
    });

    hooks?.onConfirmed?.({ paymentId: payment.id });
    return { id: subscriptionId, outcome };
  });
}
