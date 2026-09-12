/**
 * Platform governance (§91) — PLATFORM_OWNER only.
 *
 * The owner sits above every company and sees the whole estate: aggregate
 * statistics, a per-tenant breakdown, system health, and the ability to
 * suspend or reactivate a company. No tenant admin can reach any of this
 * (guarded by requirePlatformOwner; the platform.* permissions are granted to
 * PLATFORM_OWNER alone).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '@nexora/domain';
import type { NexoraContext } from '../context.js';
import { writeAudit } from '../plugins/auth.js';
import { createOutboxEvent } from '../outbox.js';

export async function registerPlatformRoutes(app: FastifyInstance, nexora: NexoraContext): Promise<void> {
  // ---- Estate-wide summary -----------------------------------------------
  app.get(
    '/api/v1/platform/summary',
    { preHandler: [app.requirePlatformOwner] },
    async (_request, reply) => {
      const [
        tenants,
        activeTenants,
        customers,
        activeSubscriptions,
        paymentsSuccess,
        revenue,
        pendingPayments,
        expiredPayments,
        cancelledPayments,
        staff,
        routersOnline,
        routersTotal,
        failedOps,
      ] = await Promise.all([
        nexora.prisma.tenant.count(),
        nexora.prisma.tenant.count({ where: { status: { in: ['ACTIVE', 'TRIAL'] } } }),
        nexora.prisma.customer.count(),
        nexora.prisma.subscription.count({ where: { status: { in: ['ACTIVE', 'FUP'] } } }),
        nexora.prisma.payment.count({ where: { status: 'SUCCESS' } }),
        nexora.prisma.payment.aggregate({ where: { status: 'SUCCESS' }, _sum: { amountMinor: true } }),
        nexora.prisma.payment.count({ where: { status: 'PENDING' } }),
        nexora.prisma.payment.count({ where: { status: 'EXPIRED' } }),
        nexora.prisma.payment.count({ where: { status: 'CANCELLED' } }),
        nexora.prisma.user.count(),
        nexora.prisma.router.count({ where: { status: 'ONLINE' } }),
        nexora.prisma.router.count(),
        nexora.prisma.networkOperation.count({ where: { status: 'PERMANENT_FAILURE' } }),
      ]);

      return await reply.status(200).send({
        summary: {
          tenants,
          activeTenants,
          customers,
          activeSubscriptions,
          paymentsSuccess,
          revenueMinor: revenue._sum.amountMinor ?? 0,
          pendingPayments,
          expiredPayments,
          cancelledPayments,
          staff,
          routersOnline,
          routersTotal,
          failedNetworkOperations: failedOps,
        },
      });
    },
  );

  // ---- Per-tenant breakdown ----------------------------------------------
  app.get(
    '/api/v1/platform/tenants',
    { preHandler: [app.requirePlatformOwner] },
    async (_request, reply) => {
      const tenants = await nexora.prisma.tenant.findMany({ orderBy: { createdAt: 'desc' } });

      // Aggregate per-tenant counts in three grouped queries (not N+1).
      const [customerGroups, subGroups, revenueGroups] = await Promise.all([
        nexora.prisma.customer.groupBy({ by: ['tenantId'], _count: { _all: true } }),
        nexora.prisma.subscription.groupBy({
          by: ['tenantId'],
          where: { status: { in: ['ACTIVE', 'FUP'] } },
          _count: { _all: true },
        }),
        nexora.prisma.payment.groupBy({
          by: ['tenantId'],
          where: { status: 'SUCCESS' },
          _sum: { amountMinor: true },
          _count: { _all: true },
        }),
      ]);
      const custBy = new Map(customerGroups.map((g) => [g.tenantId, g._count._all]));
      const subBy = new Map(subGroups.map((g) => [g.tenantId, g._count._all]));
      const revBy = new Map(revenueGroups.map((g) => [g.tenantId, { sum: g._sum.amountMinor ?? 0, count: g._count._all }]));

      return await reply.status(200).send({
        data: tenants.map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.name,
          status: t.status,
          contactEmail: t.contactEmail,
          mpesaConfigured:
            t.mpesaConsumerKeyEnc !== null && t.mpesaConsumerSecretEnc !== null && t.mpesaPasskeyEnc !== null,
          mpesaChannel: t.mpesaChannel,
          customers: custBy.get(t.id) ?? 0,
          activeSubscriptions: subBy.get(t.id) ?? 0,
          revenueMinor: revBy.get(t.id)?.sum ?? 0,
          successfulPayments: revBy.get(t.id)?.count ?? 0,
          createdAt: t.createdAt.toISOString(),
        })),
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/platform/tenants/:id',
    { preHandler: [app.requirePlatformOwner] },
    async (request, reply) => {
      const t = await nexora.prisma.tenant.findUnique({ where: { id: request.params.id } });
      if (t === null) {
        return await reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Tenant not found.', correlationId: request.id, retryable: false },
        });
      }
      const [customers, staff, activeSubscriptions, revenue, routers] = await Promise.all([
        nexora.prisma.customer.count({ where: { tenantId: t.id } }),
        nexora.prisma.user.count({ where: { tenantId: t.id } }),
        nexora.prisma.subscription.count({ where: { tenantId: t.id, status: { in: ['ACTIVE', 'FUP'] } } }),
        nexora.prisma.payment.aggregate({ where: { tenantId: t.id, status: 'SUCCESS' }, _sum: { amountMinor: true } }),
        nexora.prisma.router.count({ where: { tenantId: t.id } }),
      ]);
      return await reply.status(200).send({
        tenant: {
          id: t.id,
          slug: t.slug,
          name: t.name,
          status: t.status,
          contactEmail: t.contactEmail,
          contactPhone: t.contactPhone,
          country: t.country,
          currency: t.currency,
          createdAt: t.createdAt.toISOString(),
          mpesaChannel: t.mpesaChannel,
          mpesaEnv: t.mpesaEnv,
          mpesaConfigured:
            t.mpesaConsumerKeyEnc !== null && t.mpesaConsumerSecretEnc !== null && t.mpesaPasskeyEnc !== null,
        },
        stats: { customers, staff, activeSubscriptions, revenueMinor: revenue._sum.amountMinor ?? 0, routers },
      });
    },
  );

  const statusSchema = z.object({ status: z.enum(['TRIAL', 'ACTIVE', 'SUSPENDED', 'CLOSED']) });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/platform/tenants/:id',
    { preHandler: [app.requirePlatformOwner] },
    async (request, reply) => {
      const parsed = statusSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('status is required.', {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        }, request.id);
      }
      if (request.params.id === 'platform' || request.params.id === 'default') {
        return await reply.status(409).send({
          error: { code: 'PROTECTED_TENANT', message: 'Reserved tenants cannot change status.', correlationId: request.id, retryable: false },
        });
      }
      const existing = await nexora.prisma.tenant.findUnique({ where: { id: request.params.id } });
      if (existing === null) {
        return await reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Tenant not found.', correlationId: request.id, retryable: false },
        });
      }
      await nexora.prisma.tenant.update({ where: { id: request.params.id }, data: { status: parsed.data.status } });
      // Suspending/closing a company must lock its staff out immediately — not
      // wait for token TTL (autopsy F5).
      if (parsed.data.status === 'SUSPENDED' || parsed.data.status === 'CLOSED') {
        await nexora.prisma.userSession.updateMany({
          where: { user: { tenantId: request.params.id }, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await createOutboxEvent(nexora, {
        eventType: parsed.data.status === 'SUSPENDED' ? 'TENANT_SUSPENDED' : 'TENANT_ACTIVATED',
        aggregateType: 'Tenant',
        aggregateId: request.params.id,
        payload: { tenantId: request.params.id, status: parsed.data.status },
        correlationId: request.id,
      });
      await writeAudit(nexora, {
        action: 'TENANT_STATUS_CHANGED',
        resourceType: 'Tenant',
        resourceId: request.params.id,
        actor: request.principal,
        beforeState: { status: existing.status },
        afterState: { status: parsed.data.status },
        correlationId: request.id,
        ipAddress: request.ip,
      });
      return await reply.status(200).send({ ok: true, status: parsed.data.status });
    },
  );

  // ---- System health (cross-tenant operational posture) ------------------
  app.get(
    '/api/v1/platform/health',
    { preHandler: [app.requirePlatformOwner] },
    async (_request, reply) => {
      const [outboxPending, outboxDead, jobsQueued, jobsFailed, routersOffline, staleSessions] = await Promise.all([
        nexora.prisma.outboxEvent.count({ where: { status: 'PENDING' } }),
        nexora.prisma.outboxEvent.count({ where: { status: 'DEAD' } }),
        nexora.prisma.job.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } }),
        nexora.prisma.job.count({ where: { status: 'FAILED' } }),
        nexora.prisma.router.count({ where: { status: 'OFFLINE' } }),
        nexora.prisma.customerSession.count({ where: { status: { in: ['ONLINE', 'THROTTLED'] } } }),
      ]);
      return await reply.status(200).send({
        health: { outboxPending, outboxDead, jobsQueued, jobsFailed, routersOffline, liveSessions: staleSessions },
      });
    },
  );
}
