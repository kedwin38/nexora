/**
 * Admin control plane (§55, §4): summary, customers, payments,
 * network operations (+ admin retry), audit tail.
 */

import type { FastifyInstance } from 'fastify';
import { networkOperationMachine } from '@nexora/domain';
import { resetFupForSubscription } from '@nexora/engines';
import type { NexoraContext } from '../context.js';
import { writeAudit } from '../plugins/auth.js';

export async function registerAdminRoutes(app: FastifyInstance, nexora: NexoraContext): Promise<void> {
  app.get(
    '/api/v1/admin/summary',
    { preHandler: [app.requirePermission('monitoring.read')] },
    async (_request, reply) => {
      const [customers, activeSubscriptions, paymentsSuccess, revenue, pendingPayments, queuedOps, drift] =
        await Promise.all([
          nexora.prisma.customer.count(),
          nexora.prisma.subscription.count({ where: { status: { in: ['ACTIVE', 'FUP'] } } }),
          nexora.prisma.payment.count({ where: { status: 'SUCCESS' } }),
          nexora.prisma.payment.aggregate({ where: { status: 'SUCCESS' }, _sum: { amountMinor: true } }),
          nexora.prisma.payment.count({ where: { status: 'PENDING' } }),
          nexora.prisma.networkOperation.count({ where: { status: { in: ['QUEUED', 'PROCESSING', 'RETRYING'] } } }),
          nexora.prisma.networkOperation.count({ where: { status: 'PERMANENT_FAILURE' } }),
        ]);

      return await reply.status(200).send({
        summary: {
          customers,
          activeSubscriptions,
          paymentsSuccess,
          revenueMinor: revenue._sum.amountMinor ?? 0,
          pendingPayments,
          queuedNetworkOperations: queuedOps,
          failedNetworkOperations: drift,
        },
      });
    },
  );

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/api/v1/admin/customers',
    { preHandler: [app.requirePermission('customer.read')] },
    async (request, reply) => {
      const page = Math.max(1, Number(request.query.page ?? 1));
      const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 20)));
      const [customers, total] = await Promise.all([
        nexora.prisma.customer.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          select: {
            id: true,
            customerNumber: true,
            accountType: true,
            status: true,
            phoneNumber: true,
            displayName: true,
            createdAt: true,
            subscriptions: {
              where: { status: { in: ['ACTIVE', 'FUP'] } },
              take: 1,
              select: { id: true, status: true, expiryTime: true, package: { select: { name: true } } },
            },
          },
        }),
        nexora.prisma.customer.count(),
      ]);

      return await reply.status(200).send({
        data: customers.map((c) => ({
          id: c.id,
          customerNumber: c.customerNumber,
          accountType: c.accountType,
          status: c.status,
          phone: c.phoneNumber,
          displayName: c.displayName,
          createdAt: c.createdAt.toISOString(),
          activeSubscription: c.subscriptions[0]
            ? {
                id: c.subscriptions[0].id,
                status: c.subscriptions[0].status,
                packageName: c.subscriptions[0].package.name,
                expiryTime: c.subscriptions[0].expiryTime?.toISOString() ?? null,
              }
            : null,
        })),
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      });
    },
  );

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/api/v1/admin/payments',
    { preHandler: [app.requirePermission('payment.read')] },
    async (request, reply) => {
      const page = Math.max(1, Number(request.query.page ?? 1));
      const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 20)));
      const where = request.query.status !== undefined ? { status: request.query.status as never } : {};
      const [payments, total] = await Promise.all([
        nexora.prisma.payment.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          select: {
            id: true,
            status: true,
            amountMinor: true,
            currency: true,
            receipt: true,
            phoneNumber: true,
            providerTransactionId: true,
            createdAt: true,
            completedAt: true,
            subscriptionId: true,
            package: { select: { name: true } },
          },
        }),
        nexora.prisma.payment.count({ where }),
      ]);

      return await reply.status(200).send({
        data: payments,
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      });
    },
  );

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/api/v1/admin/network-operations',
    { preHandler: [app.requirePermission('network_operation.read')] },
    async (request, reply) => {
      const page = Math.max(1, Number(request.query.page ?? 1));
      const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 20)));
      const where = request.query.status !== undefined ? { status: request.query.status as never } : {};
      const [operations, total] = await Promise.all([
        nexora.prisma.networkOperation.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          include: { router: { select: { name: true, host: true } } },
        }),
        nexora.prisma.networkOperation.count({ where }),
      ]);

      return await reply.status(200).send({
        data: operations.map((op) => ({
          id: op.id,
          type: op.operationType,
          status: op.status,
          attempts: `${op.attempts}/${op.maxAttempts}`,
          router: op.router.name,
          routerHost: op.router.host,
          lastError: op.lastError,
          createdAt: op.createdAt.toISOString(),
          completedAt: op.completedAt?.toISOString() ?? null,
          correlationId: op.correlationId,
        })),
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/network-operations/:id/retry',
    { preHandler: [app.requirePermission('network_operation.retry')] },
    async (request, reply) => {
      const op = await nexora.prisma.networkOperation.findUnique({ where: { id: request.params.id } });
      if (op === null) {
        return await reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Network operation not found.', correlationId: request.id, retryable: false },
        });
      }
      networkOperationMachine.assertTransition(op.status, 'QUEUED');
      await nexora.prisma.networkOperation.update({
        where: { id: op.id },
        data: { status: 'QUEUED', attempts: 0, nextAttemptAt: new Date(), lastError: null },
      });
      await writeAudit(nexora, {
        action: 'NETWORK_OPERATION_RETRY',
        resourceType: 'NetworkOperation',
        resourceId: op.id,
        actor: request.principal,
        beforeState: { status: op.status },
        afterState: { status: 'QUEUED' },
        correlationId: request.id,
        ipAddress: request.ip,
      });
      return await reply.status(202).send({ ok: true });
    },
  );

  app.get(
    '/api/v1/admin/audit',
    { preHandler: [app.requirePermission('audit.read')] },
    async (request, reply) => {
      const page = Math.max(1, Number((request.query as Record<string, string | undefined>).page ?? 1));
      const limit = Math.min(100, Math.max(1, Number((request.query as Record<string, string | undefined>).limit ?? 20)));
      const [logs, total] = await Promise.all([
        nexora.prisma.auditLog.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        nexora.prisma.auditLog.count(),
      ]);
      return await reply.status(200).send({ data: logs, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
    },
  );

  // ---- Sessions (§55) ----

  app.get(
    '/api/v1/admin/sessions',
    { preHandler: [app.requirePermission('session.read')] },
    async (_request, reply) => {
      const sessions = await nexora.prisma.customerSession.findMany({
        where: { status: { in: ['ONLINE', 'THROTTLED', 'AUTHORIZED'] } },
        orderBy: { lastSeenAt: 'desc' },
        take: 100,
        select: {
          id: true,
          macAddress: true,
          ipAddress: true,
          status: true,
          startedAt: true,
          lastSeenAt: true,
          downloadBytes: true,
          uploadBytes: true,
          customer: { select: { customerNumber: true, displayName: true } },
          subscription: { select: { subscriptionNumber: true, status: true } },
        },
      });
      return await reply.status(200).send({
        data: sessions.map((s) => ({
          id: s.id,
          macAddress: s.macAddress,
          ipAddress: s.ipAddress,
          status: s.status,
          startedAt: s.startedAt.toISOString(),
          lastSeenAt: s.lastSeenAt.toISOString(),
          downloadBytes: s.downloadBytes.toString(),
          uploadBytes: s.uploadBytes.toString(),
          customer: s.customer.displayName ?? s.customer.customerNumber,
          subscription: s.subscription.subscriptionNumber,
          subscriptionStatus: s.subscription.status,
        })),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/sessions/:id/disconnect',
    { preHandler: [app.requirePermission('session.disconnect')] },
    async (request, reply) => {
      const session = await nexora.prisma.customerSession.findUnique({
        where: { id: request.params.id },
        include: { subscription: { include: { networkPolicy: true } } },
      });
      if (session === null) {
        return await reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Session not found.', correlationId: request.id, retryable: false },
        });
      }
      const router = await nexora.prisma.router.findFirst({ where: { status: { not: 'OFFLINE' } } });
      const desired = session.subscription.networkPolicy?.desiredState as
        | { macAddress: string | null; authorized: boolean; rateLimit: { downloadKbps: number; uploadKbps: number } | null }
        | undefined;

      const now = new Date();
      await nexora.prisma.$transaction(async (tx) => {
        await tx.customerSession.update({
          where: { id: session.id },
          data: { status: 'ENDED', endedAt: now, terminationReason: 'ADMIN_DISCONNECT' },
        });
        if (router !== null && (desired?.macAddress ?? session.macAddress) !== null) {
          await tx.networkOperation.create({
            data: {
              routerId: router.id,
              customerId: session.customerId,
              subscriptionId: session.subscriptionId,
              operationType: 'DISCONNECT_SESSION',
              desiredState: {
                macAddress: desired?.macAddress ?? session.macAddress,
                authorized: true,
                rateLimit: desired?.rateLimit ?? null,
              },
              status: 'QUEUED',
              idempotencyKey: `disconnect:${session.id}:${now.getTime()}`,
              correlationId: request.id,
            },
          });
        }
      });
      await writeAudit(nexora, {
        action: 'SESSION_DISCONNECTED',
        resourceType: 'Session',
        resourceId: session.id,
        actor: request.principal,
        beforeState: { status: session.status },
        afterState: { status: 'ENDED' },
        correlationId: request.id,
        ipAddress: request.ip,
      });
      return await reply.status(202).send({ ok: true });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/subscriptions/:id/fup-reset',
    { preHandler: [app.requirePermission('fup.reset')] },
    async (request, reply) => {
      try {
        await resetFupForSubscription(nexora.prisma, request.params.id, request.id);
      } catch (error) {
        return await reply.status(409).send({
          error: {
            code: 'FUP_RESET_REJECTED',
            message: (error as Error).message,
            correlationId: request.id,
            retryable: false,
          },
        });
      }
      await writeAudit(nexora, {
        action: 'FUP_RESET',
        resourceType: 'Subscription',
        resourceId: request.params.id,
        actor: request.principal,
        correlationId: request.id,
        ipAddress: request.ip,
      });
      return await reply.status(202).send({ ok: true });
    },
  );
}
