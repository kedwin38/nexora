/**
 * Customer identity: registration (phone + password), login, self profile
 * with live subscription state (§54). Guests purchase without accounts in
 * Stage 3's guest flow.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConflictError, UnauthorizedError, ValidationError } from '@nexora/domain';
import { normalizeKenyanMsisdn } from '@nexora/payment-sdk';
import type { NexoraContext } from '../context.js';
import { writeAudit } from '../plugins/auth.js';
import { createOutboxEvent } from '../outbox.js';

const registerSchema = z.object({
  phone: z.string(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1).max(100).optional(),
});

const loginSchema = z.object({
  phone: z.string(),
  password: z.string().min(1),
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

export async function registerCustomerRoutes(app: FastifyInstance, nexora: NexoraContext): Promise<void> {
  app.post<{ Body: unknown }>(
    '/api/v1/customers/register',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = parseOrThrow(registerSchema, request.body, request.id);
      const phone = normalizeKenyanMsisdn(input.phone);
      if (phone === null) {
        throw new ValidationError('Invalid Kenyan phone number.', undefined, request.id);
      }

      const existing = await nexora.prisma.customer.findFirst({
        where: { phoneNumber: phone, tenantId: 'default' },
      });
      if (existing !== null) {
        throw new ConflictError('A customer with this phone number already exists.', undefined, request.id);
      }

      const passwordHash = await nexora.hasher.hash(input.password);
      const customer = await nexora.prisma.customer.create({
        data: {
          customerNumber: `CUS-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          accountType: 'REGISTERED',
          status: 'ACTIVE',
          phoneNumber: phone,
          passwordHash,
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        },
      });

      await writeAudit(nexora, {
        action: 'CUSTOMER_REGISTERED',
        resourceType: 'Customer',
        resourceId: customer.id,
        actor: null,
        correlationId: request.id,
        ipAddress: request.ip,
      });
      await createOutboxEvent(nexora, {
        eventType: 'CUSTOMER_CREATED',
        aggregateType: 'Customer',
        aggregateId: customer.id,
        payload: { customerId: customer.id, phone },
        correlationId: request.id,
      });

      const issued = await nexora.tokens.issue(
        { subjectType: 'customer', subjectId: customer.id, role: 'CUSTOMER' },
        { ip: request.ip, userAgent: request.headers['user-agent'] },
      );

      return await reply.status(201).send({
        token: issued.token,
        expiresAt: issued.expiresAt.toISOString(),
        customer: { id: customer.id, phone: customer.phoneNumber, displayName: customer.displayName },
      });
    },
  );

  app.post<{ Body: unknown }>(
    '/api/v1/customers/login',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = parseOrThrow(loginSchema, request.body, request.id);
      const phone = normalizeKenyanMsisdn(input.phone);
      if (phone === null) {
        throw new ValidationError('Invalid Kenyan phone number.', undefined, request.id);
      }
      const customer = await nexora.prisma.customer.findFirst({
        where: { phoneNumber: phone, tenantId: 'default' },
      });
      const passwordOk =
        customer !== null && customer.passwordHash !== null
          ? await nexora.hasher.verify(input.password, customer.passwordHash)
          : false;
      if (customer === null || customer.passwordHash === null || !passwordOk) {
        throw new UnauthorizedError('Invalid credentials.', request.id);
      }

      const issued = await nexora.tokens.issue(
        { subjectType: 'customer', subjectId: customer.id, role: 'CUSTOMER' },
        { ip: request.ip, userAgent: request.headers['user-agent'] },
      );
      await nexora.prisma.customer.update({ where: { id: customer.id }, data: { lastLoginAt: new Date() } });

      return await reply.status(200).send({
        token: issued.token,
        expiresAt: issued.expiresAt.toISOString(),
        customer: { id: customer.id, phone: customer.phoneNumber, displayName: customer.displayName },
      });
    },
  );

  app.get('/api/v1/customers/me', { preHandler: [app.requireCustomer] }, async (request, reply) => {
    const customerId = request.principal!.subjectId;
    const customer = await nexora.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        customerNumber: true,
        phoneNumber: true,
        displayName: true,
        status: true,
        createdAt: true,
        subscriptions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            subscriptionNumber: true,
            status: true,
            startTime: true,
            expiryTime: true,
            policySnapshot: true,
            package: { select: { name: true } },
            fupStates: { orderBy: { periodStart: 'desc' }, take: 1, select: { state: true, usedBytes: true, limitBytes: true } },
          },
        },
      },
    });
    if (customer === null) throw new UnauthorizedError(undefined, request.id);

    const subscription = customer.subscriptions[0] ?? null;
    const fup = subscription?.fupStates[0] ?? null;

    return await reply.status(200).send({
      customer: {
        id: customer.id,
        customerNumber: customer.customerNumber,
        phone: customer.phoneNumber,
        displayName: customer.displayName,
        status: customer.status,
        memberSince: customer.createdAt.toISOString(),
      },
      subscription:
        subscription === null
          ? null
          : {
              id: subscription.id,
              subscriptionNumber: subscription.subscriptionNumber,
              status: subscription.status,
              packageName: subscription.package.name,
              startTime: subscription.startTime?.toISOString() ?? null,
              expiryTime: subscription.expiryTime?.toISOString() ?? null,
              policySnapshot: subscription.policySnapshot,
            },
      fup:
        fup === null
          ? null
          : {
              state: fup.state,
              usedBytes: fup.usedBytes.toString(),
              limitBytes: fup.limitBytes.toString(),
            },
    });
  });
}
