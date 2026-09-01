/**
 * Guest purchase flow (§9, §36): package → phone → payment → temporary
 * service identity → provisioning → expiry. No account required.
 *
 * POST /api/v1/guests/purchase  — creates (or reuses) a GUEST customer for
 *   the phone, binds the device MAC, initiates the payment, and issues an
 *   access code for status polling.
 * GET  /api/v1/guests/:accessCode — service status for the guest portal.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '@nexora/domain';
import { normalizeKenyanMsisdn } from '@nexora/payment-sdk';
import type { NexoraContext } from '../context.js';
import { createOutboxEvent } from '../outbox.js';

const purchaseSchema = z.object({
  phone: z.string(),
  packageId: z.string().uuid(),
  macAddress: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/),
  idempotencyKey: z.string().uuid().optional(),
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

function newAccessCode(): string {
  return `GST-${randomBytes(4).toString('hex').toUpperCase()}`;
}

export async function registerGuestRoutes(app: FastifyInstance, nexora: NexoraContext): Promise<void> {
  app.post<{ Body: unknown }>(
    '/api/v1/guests/purchase',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = parseOrThrow(purchaseSchema, request.body, request.id);
      const phone = normalizeKenyanMsisdn(input.phone);
      if (phone === null) {
        throw new ValidationError('Invalid Kenyan phone number.', undefined, request.id);
      }
      const pkg = await nexora.prisma.package.findUnique({ where: { id: input.packageId } });
      if (pkg === null || pkg.status !== 'ACTIVE') {
        throw new NotFoundError('Package', input.packageId, request.id);
      }

      // Guest identity: one GUEST customer per phone (upgradeable later to
      // REGISTERED when they create a password — §8.1 account_type).
      const existing = await nexora.prisma.customer.findFirst({ where: { phoneNumber: phone, tenantId: 'default' } });
      const customer =
        existing !== null
          ? existing
          : await nexora.prisma.customer.create({
              data: {
                customerNumber: `GST-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`,
                accountType: 'GUEST',
                status: 'ACTIVE',
                phoneNumber: phone,
              },
            });
      if (existing === null) {
        await createOutboxEvent(nexora, {
          eventType: 'GUEST_IDENTITY_CREATED',
          aggregateType: 'Customer',
          aggregateId: customer.id,
          payload: { customerId: customer.id, phone },
          correlationId: request.id,
        });
      }

      // Temporary service identity for status polling (§36).
      const accessCode = newAccessCode();
      const expiryHours = Math.max(1, Math.ceil(pkg.durationSeconds / 3600));
      await nexora.prisma.guestAccess.upsert({
        where: { customerId: customer.id },
        update: { accessCode, expiresAt: new Date(Date.now() + expiryHours * 3_600_000) },
        create: {
          customerId: customer.id,
          accessCode,
          expiresAt: new Date(Date.now() + expiryHours * 3_600_000),
        },
      });

      // Bind the device and initiate the payment (same path as registered users).
      await nexora.prisma.device.upsert({
        where: { customerId_macAddress: { customerId: customer.id, macAddress: input.macAddress.toUpperCase() } },
        update: { lastSeenAt: new Date() },
        create: { customerId: customer.id, macAddress: input.macAddress.toUpperCase() },
      });

      const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
      const reserved = await nexora.prisma.payment.findUnique({
        where: { provider_clientReference: { provider: 'MPESA', clientReference: idempotencyKey } },
      });
      if (reserved !== null) {
        return await reply.status(200).send({
          paymentId: reserved.id,
          status: reserved.status,
          accessCode: (await nexora.prisma.guestAccess.findUnique({ where: { customerId: customer.id } }))?.accessCode ?? null,
          idempotentReplay: true,
        });
      }

      const payment = await nexora.prisma.payment.create({
        data: {
          provider: 'MPESA',
          clientReference: idempotencyKey,
          customerId: customer.id,
          packageId: pkg.id,
          allocation: 'SUBSCRIPTION_PURCHASE',
          amountMinor: pkg.priceMinor,
          currency: pkg.currency,
          status: 'INITIATED',
          phoneNumber: phone,
          correlationId: request.id,
        },
      });

      let providerTransactionId: string;
      try {
        const push = await nexora.payments.initiateStkPush({
          phoneNumber: phone,
          amountMinor: pkg.priceMinor,
          accountReference: 'NEXORA',
          description: pkg.name,
          transactionReference: idempotencyKey,
        });
        providerTransactionId = push.providerTransactionId;
      } catch (error) {
        await nexora.prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED', failureReason: (error as Error).message.slice(0, 500) },
        });
        return await reply.status(502).send({
          error: { code: 'PAYMENT_PROVIDER_ERROR', message: 'Payment provider rejected the request.', correlationId: request.id, retryable: true },
        });
      }

      await nexora.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'PENDING', providerTransactionId },
      });
      nexora.metrics.paymentOutcome('initiated');
      const { scheduleMockAutoConfirm } = await import('./payment.routes.js');
      scheduleMockAutoConfirm(nexora, { paymentId: payment.id, providerTransactionId, amountMinor: pkg.priceMinor });
      await createOutboxEvent(nexora, {
        eventType: 'PAYMENT_INITIATED',
        aggregateType: 'Payment',
        aggregateId: payment.id,
        payload: { paymentId: payment.id, packageId: pkg.id, amountMinor: pkg.priceMinor, phone, guest: true },
        correlationId: request.id,
      });

      return await reply.status(202).send({
        paymentId: payment.id,
        status: 'PENDING',
        accessCode,
        message: 'STK push sent. Poll /api/v1/guests/{accessCode} for service status.',
      });
    },
  );

  app.get<{ Params: { accessCode: string } }>(
    '/api/v1/guests/:accessCode',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const guest = await nexora.prisma.guestAccess.findUnique({
        where: { accessCode: request.params.accessCode },
        include: {
          customer: {
            include: {
              subscriptions: {
                where: { status: { in: ['ACTIVE', 'FUP', 'PENDING', 'PROVISIONING'] } },
                orderBy: { createdAt: 'desc' },
                take: 1,
                include: { package: { select: { name: true } } },
              },
              payments: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
            },
          },
        },
      });
      if (guest === null) throw new NotFoundError('Guest access', request.params.accessCode, request.id);

      const sub = guest.customer.subscriptions[0] ?? null;
      const lastPayment = guest.customer.payments[0] ?? null;

      return await reply.status(200).send({
        serviceStatus:
          sub === null
            ? lastPayment?.status === 'PENDING'
              ? 'PAYMENT_PENDING'
              : 'NO_SERVICE'
            : sub.status === 'ACTIVE' || sub.status === 'FUP'
              ? 'ONLINE'
              : 'PROVISIONING',
        subscription: sub === null ? null : {
          packageName: sub.package.name,
          status: sub.status,
          expiryTime: sub.expiryTime?.toISOString() ?? null,
        },
        lastPaymentStatus: lastPayment?.status ?? null,
        accessExpiresAt: guest.expiresAt.toISOString(),
      });
    },
  );
}
