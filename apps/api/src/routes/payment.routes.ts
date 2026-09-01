/**
 * Payment initiation + status (§15, §16, §48).
 *
 * POST /api/v1/payments/initiate — customer-authenticated, idempotent by
 * client idempotency key (UNIQUE(provider, clientReference)). Creates the
 * Payment (INITIATED -> PENDING), PaymentAttempt and PAYMENT_INITIATED
 * outbox event, then calls the provider STK push.
 *
 * GET /api/v1/payments/:id — owner or payment.read.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ForbiddenError, NotFoundError, ValidationError } from '@nexora/domain';
import { MockPaymentProvider, normalizeKenyanMsisdn } from '@nexora/payment-sdk';
import { activateOnPaymentSuccess } from '@nexora/engines';
import type { NexoraContext } from '../context.js';
import { createOutboxEvent } from '../outbox.js';

/** Dev-only convenience: with the mock provider, deliver the "callback" after
 *  a short delay so the purchase→activation flow completes without a phone.
 *  Guarded to the mock provider — never active for Daraja. Exported for the
 *  guest purchase route to reuse. */
export function scheduleMockAutoConfirm(
  nexora: NexoraContext,
  input: { paymentId: string; providerTransactionId: string; amountMinor: number },
): void {
  if (!(nexora.payments instanceof MockPaymentProvider)) return;
  const delay = nexora.env.MOCK_PAYMENT_AUTO_CONFIRM_MS;
  if (delay <= 0) return;
  setTimeout(() => {
    void (async (): Promise<void> => {
      try {
        const payment = await nexora.prisma.payment.findUnique({
          where: { id: input.paymentId },
          include: { package: { include: { policy: true } } },
        });
        if (payment === null || payment.status !== 'PENDING') return; // cancelled/failed meanwhile
        await activateOnPaymentSuccess(nexora.prisma, {
          payment,
          receipt: `MOCKRCPT-${input.providerTransactionId.slice(-8).toUpperCase()}`,
          correlationId: `mock-cb-${input.providerTransactionId}`,
        });
        nexora.metrics.paymentOutcome('confirmed');
        nexora.logger.info('Mock payment auto-confirmed', { paymentId: input.paymentId });
      } catch (error) {
        nexora.logger.warn('Mock auto-confirm failed', {
          paymentId: input.paymentId,
          error: (error as Error).message,
        });
      }
    })();
  }, delay).unref();
}

const initiateSchema = z.object({
  packageId: z.string().uuid(),
  phone: z.string().optional(),
  idempotencyKey: z.string().uuid(),
  macAddress: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/).optional(),
});

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, body: unknown, requestId: string): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Request validation failed.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, requestId);
  }
  return parsed.data;
}

export async function registerPaymentRoutes(app: FastifyInstance, nexora: NexoraContext): Promise<void> {
  app.post<{ Body: unknown }>(
    '/api/v1/payments/initiate',
    {
      preHandler: [app.requireCustomer],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const input = parseOrThrow(initiateSchema, request.body, request.id);
      const customerId = request.principal!.subjectId;

      const customer = await nexora.prisma.customer.findUnique({ where: { id: customerId } });
      if (customer === null) throw new NotFoundError('Customer', customerId, request.id);

      const phone =
        input.phone !== undefined ? normalizeKenyanMsisdn(input.phone) : customer.phoneNumber;
      if (phone === null) {
        throw new ValidationError('Invalid Kenyan phone number.', undefined, request.id);
      }

      const pkg = await nexora.prisma.package.findUnique({
        where: { id: input.packageId },
        include: { policy: true },
      });
      if (pkg === null || pkg.status !== 'ACTIVE') {
        throw new NotFoundError('Package', input.packageId, request.id);
      }

      // Idempotency: same provider + clientReference returns the existing payment.
      const existing = await nexora.prisma.payment.findUnique({
        where: { provider_clientReference: { provider: 'MPESA', clientReference: input.idempotencyKey } },
      });
      if (existing !== null) {
        return await reply.status(200).send({
          paymentId: existing.id,
          status: existing.status,
          providerTransactionId: existing.providerTransactionId,
          idempotentReplay: true,
        });
      }

      // Reserve the payment row BEFORE the provider call (INITIATED).
      const payment = await nexora.prisma.payment.create({
        data: {
          provider: 'MPESA',
          clientReference: input.idempotencyKey,
          customerId,
          packageId: pkg.id,
          allocation: 'SUBSCRIPTION_PURCHASE',
          amountMinor: pkg.priceMinor,
          currency: pkg.currency,
          status: 'INITIATED',
          phoneNumber: phone,
          correlationId: request.id,
        },
      });

      // Bind the purchasing device so network provisioning has a target MAC.
      if (input.macAddress !== undefined) {
        await nexora.prisma.device.upsert({
          where: { customerId_macAddress: { customerId, macAddress: input.macAddress.toUpperCase() } },
          update: { lastSeenAt: new Date() },
          create: { customerId, macAddress: input.macAddress.toUpperCase() },
        });
      }

      let providerTransactionId: string;
      try {
        const push = await nexora.payments.initiateStkPush({
          phoneNumber: phone,
          amountMinor: pkg.priceMinor,
          accountReference: 'NEXORA',
          description: pkg.name,
          transactionReference: input.idempotencyKey,
        });
        providerTransactionId = push.providerTransactionId;
      } catch (error) {
        nexora.metrics.paymentOutcome('failed');
        await nexora.prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED', failureReason: (error as Error).message.slice(0, 500) },
        });
        await createOutboxEvent(nexora, {
          eventType: 'PAYMENT_FAILED',
          aggregateType: 'Payment',
          aggregateId: payment.id,
          payload: { paymentId: payment.id, reason: 'STK_PUSH_REJECTED' },
          correlationId: request.id,
        });
        return await reply.status(502).send({
          error: { code: 'PAYMENT_PROVIDER_ERROR', message: 'Payment provider rejected the request.', correlationId: request.id, retryable: true },
        });
      }

      const updated = await nexora.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'PENDING', providerTransactionId },
      });
      nexora.metrics.paymentOutcome('initiated');
      scheduleMockAutoConfirm(nexora, {
        paymentId: payment.id,
        providerTransactionId,
        amountMinor: pkg.priceMinor,
      });
      await nexora.prisma.paymentAttempt.create({
        data: {
          paymentId: payment.id,
          attemptType: 'STK_PUSH',
          responsePayload: { providerTransactionId },
        },
      });
      await createOutboxEvent(nexora, {
        eventType: 'PAYMENT_INITIATED',
        aggregateType: 'Payment',
        aggregateId: payment.id,
        payload: { paymentId: payment.id, packageId: pkg.id, amountMinor: pkg.priceMinor, phone },
        correlationId: request.id,
      });

      return await reply.status(202).send({
        paymentId: updated.id,
        status: updated.status,
        providerTransactionId,
        message: 'STK push sent. Complete the payment on your phone.',
      });
    },
  );

  app.get<{ Params: { id: string } }>('/api/v1/payments/:id', async (request, reply) => {
    const { id } = request.params;
    const payment = await nexora.prisma.payment.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        amountMinor: true,
        currency: true,
        receipt: true,
        initiatedAt: true,
        completedAt: true,
        customerId: true,
        subscriptionId: true,
        failureReason: true,
        package: { select: { name: true, durationSeconds: true } },
      },
    });
    if (payment === null) throw new NotFoundError('Payment', id, request.id);

    const principal = request.principal;
    const isOwner = principal?.subjectType === 'customer' && principal.subjectId === payment.customerId;
    const canRead = principal !== null && principal.permissions.includes('payment.read');
    if (!isOwner && !canRead) {
      if (principal === null) throw new ForbiddenError('payment.read', request.id);
      throw new ForbiddenError('payment.read', request.id);
    }

    return await reply.status(200).send({
      payment: {
        id: payment.id,
        status: payment.status,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        receipt: payment.receipt,
        packageName: payment.package?.name ?? null,
        subscriptionId: payment.subscriptionId,
        initiatedAt: payment.initiatedAt.toISOString(),
        completedAt: payment.completedAt?.toISOString() ?? null,
        failureReason: payment.failureReason,
      },
    });
  });
}
