/**
 * M-Pesa webhook: the payment→service workflow (§48).
 *
 * Idempotency: results bind to CheckoutRequestIDs we initiated; a second
 * delivery of the same callback finds Payment.status === SUCCESS and the
 * same receipt and acknowledges without side effects (§16, acceptance E).
 *
 * On success, ONE database transaction performs:
 *   Payment -> SUCCESS
 *   + Subscription created ACTIVE (policy snapshot, billing period, FUP threshold)
 *   + FupState NORMAL
 *   + NetworkPolicy desired state v1
 *   + NetworkOperation AUTHORIZE QUEUED (idempotency key)
 *   + Outbox events: PAYMENT_CONFIRMED, SUBSCRIPTION_ACTIVATED, NETWORK_PROVISION_REQUESTED
 *
 * Network calls happen LATER in network-worker — never inside the transaction (§72).
 */

import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { paymentMachine, subscriptionMachine } from '@nexora/domain';
import type { NexoraContext } from '../context.js';

type PaymentWithPackage = Prisma.PaymentGetPayload<{
  include: { package: { include: { policy: true } } };
}>;

export async function registerWebhookRoutes(app: FastifyInstance, nexora: NexoraContext): Promise<void> {
  app.post<{ Body: unknown }>(
    '/api/v1/webhooks/mpesa',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      let callback;
      try {
        callback = await nexora.payments.parseCallback(request.body, request.headers);
      } catch (error) {
        nexora.logger.warn('M-Pesa callback unparseable', {
          correlationId: request.id,
          error: (error as Error).message,
        });
        return await reply.status(200).send({ received: true }); // ack; never retry garbage
      }

      const correlationId = `cb-${callback.providerTransactionId}`;

      try {
        const payment = await nexora.prisma.payment.findUnique({
          where: { provider_providerTransactionId: { provider: 'MPESA', providerTransactionId: callback.providerTransactionId } },
          include: { package: { include: { policy: true } } },
        });

        if (payment === null) {
          // Not ours (test ping / cross-wired shortcode) — acknowledge and ignore.
          nexora.logger.warn('M-Pesa callback for unknown transaction', { correlationId });
          return await reply.status(200).send({ received: true });
        }

        // Idempotent replay: already terminal with the same receipt.
        if (payment.status === 'SUCCESS') {
          nexora.logger.info('Duplicate M-Pesa callback acknowledged (no-op)', { correlationId });
          return await reply.status(200).send({ received: true });
        }

        if (callback.resultCode !== 0) {
          // Failed / cancelled by user.
          paymentMachine.assertTransition(payment.status, 'FAILED');
          await nexora.prisma.$transaction(async (tx) => {
            await tx.payment.update({
              where: { id: payment.id },
              data: {
                status: 'FAILED',
                failureReason: callback.resultDesc.slice(0, 500),
                completedAt: new Date(),
              },
            });
            await tx.paymentAttempt.create({
              data: {
                paymentId: payment.id,
                attemptType: 'CALLBACK',
                responsePayload: { resultCode: callback.resultCode, resultDesc: callback.resultDesc },
              },
            });
            await tx.outboxEvent.create({
              data: {
                eventType: 'PAYMENT_FAILED',
                aggregateType: 'Payment',
                aggregateId: payment.id,
                payload: { paymentId: payment.id, resultCode: callback.resultCode },
                correlationId,
              },
            });
          });
          return await reply.status(200).send({ received: true });
        }

        // Success — verify amount if the provider reported it.
        if (callback.amountMinor !== undefined && callback.amountMinor !== payment.amountMinor) {
          nexora.logger.error('M-Pesa callback amount mismatch — marking FAILED', {
            correlationId,
            expected: payment.amountMinor,
            received: callback.amountMinor,
          });
          await nexora.prisma.payment.update({
            where: { id: payment.id },
            data: { status: 'FAILED', failureReason: 'AMOUNT_MISMATCH', completedAt: new Date() },
          });
          return await reply.status(200).send({ received: true });
        }

        const subscription = await activateOnPaymentSuccess(nexora, {
          payment,
          receipt: callback.receipt ?? 'UNKNOWN',
          correlationId,
        });

        nexora.metrics.paymentOutcome('confirmed');
        nexora.logger.info('Payment confirmed — subscription active', {
          correlationId,
          paymentId: payment.id,
          subscriptionId: subscription.id,
        });
        return await reply.status(200).send({ received: true });
      } catch (error) {
        // Always 200 to the provider; retry via reconciliation, not webhook retries (§77).
        nexora.logger.error('M-Pesa callback processing error', {
          correlationId,
          error: (error as Error).message,
          stack: (error as Error).stack,
        });
        return await reply.status(200).send({ received: true });
      }
    },
  );
}

export async function activateOnPaymentSuccess(
  nexora: NexoraContext,
  input: {
    payment: PaymentWithPackage;
    receipt: string;
    correlationId: string;
  },
): Promise<{ id: string }> {
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

  return await nexora.prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    paymentMachine.assertTransition(payment.status, 'SUCCESS');

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'SUCCESS',
        receipt: input.receipt,
        completedAt: now,
      },
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
    let subscriptionStatus: string;

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
      subscriptionStatus = 'RENEWED';
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
      subscriptionStatus = 'ACTIVATED';
    }

    if (customer.status === 'PENDING') {
      await tx.customer.update({ where: { id: customer.id }, data: { status: 'ACTIVE' } });
    }

    for (const [eventType, payload] of [
      ['PAYMENT_CONFIRMED', { paymentId: payment.id, receipt: input.receipt, amountMinor: payment.amountMinor }],
      [subscriptionStatus === 'RENEWED' ? 'SUBSCRIPTION_RENEWED' : 'SUBSCRIPTION_ACTIVATED', { subscriptionId }],
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

    return { id: subscriptionId };
  });
}
