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
import { paymentMachine } from '@nexora/domain';
import { activateOnPaymentSuccess } from '@nexora/engines';
import { classifyStkResultCode, parseStkCallback } from '@nexora/payment-sdk';
import type { NexoraContext } from '../context.js';

export async function registerWebhookRoutes(app: FastifyInstance, nexora: NexoraContext): Promise<void> {
  app.post<{ Body: unknown }>(
    '/api/v1/webhooks/mpesa',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      let callback;
      try {
        // Parse the real Daraja shape directly — it needs no credentials, so a
        // real callback is confirmed even when the PLATFORM default provider is
        // `mock` while tenants collect through their own Daraja app (autopsy F3).
        // Fall back to the configured provider's parser for dev/mock bodies.
        callback = parseStkCallback(request.body) ?? (await nexora.payments.parseCallback(request.body, request.headers));
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

        // Idempotent replay: already terminal (SUCCESS or any closed-out state).
        if (payment.status === 'SUCCESS' || payment.status === 'CANCELLED' || payment.status === 'EXPIRED') {
          nexora.logger.info('Duplicate/terminal M-Pesa callback acknowledged (no-op)', { correlationId, status: payment.status });
          return await reply.status(200).send({ received: true });
        }

        if (callback.resultCode !== 0) {
          // Classify the failure precisely so nothing is left ambiguous:
          //   1032 -> CANCELLED (user declined)   timeout codes -> EXPIRED   else -> FAILED.
          const outcome = classifyStkResultCode(callback.resultCode);
          const status = outcome === 'CANCELLED' ? 'CANCELLED' : outcome === 'TIMEOUT' ? 'EXPIRED' : 'FAILED';
          const eventType = status === 'CANCELLED' ? 'PAYMENT_CANCELLED' : status === 'EXPIRED' ? 'PAYMENT_EXPIRED' : 'PAYMENT_FAILED';
          paymentMachine.assertTransition(payment.status, status);
          await nexora.prisma.$transaction(async (tx) => {
            await tx.payment.update({
              where: { id: payment.id },
              data: {
                status,
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
                eventType,
                aggregateType: 'Payment',
                aggregateId: payment.id,
                payload: { paymentId: payment.id, resultCode: callback.resultCode, status },
                correlationId,
              },
            });
          });
          nexora.metrics.paymentOutcome('failed');
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

        const subscription = await activateOnPaymentSuccess(nexora.prisma, {
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
