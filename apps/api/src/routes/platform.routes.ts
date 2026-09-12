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
import { NotFoundError, ValidationError } from '@nexora/domain';
import { encryptSecret } from '@nexora/auth';
import { runPlatformBillingCycle, runMonitorCycle } from '@nexora/engines';
import type { NexoraContext } from '../context.js';
import { writeAudit } from '../plugins/auth.js';
import { createOutboxEvent } from '../outbox.js';

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, body: unknown, requestId: string): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Request validation failed.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, requestId);
  }
  return parsed.data;
}

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

  // ---- Analytics: registered users, revenue, MRR, growth -----------------
  app.get(
    '/api/v1/platform/analytics',
    { preHandler: [app.requirePlatformOwner] },
    async (_request, reply) => {
      const now = new Date();
      const day = 24 * 60 * 60 * 1000;
      const since30 = new Date(now.getTime() - 30 * day);

      // 14-day revenue timeseries (ISP customer collections, platform-wide).
      const paidWindow = await nexora.prisma.payment.findMany({
        where: { status: 'SUCCESS', completedAt: { gte: new Date(now.getTime() - 14 * day) } },
        select: { amountMinor: true, completedAt: true, tenantId: true },
      });
      const byDay = new Map<string, number>();
      for (let i = 13; i >= 0; i -= 1) {
        const d = new Date(now.getTime() - i * day);
        byDay.set(d.toISOString().slice(0, 10), 0);
      }
      for (const p of paidWindow) {
        const key = (p.completedAt ?? now).toISOString().slice(0, 10);
        if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + p.amountMinor);
      }

      // Platform MRR from active paying plans + subscription revenue collected.
      const [payingTenants, planRevenue, platformCollected, platformPending, tenantsTotal, tenantsNew, customers, staff, activeSubs, gmv] =
        await Promise.all([
          nexora.prisma.tenant.groupBy({ by: ['planStatus'], _count: { _all: true } }),
          nexora.prisma.tenant.findMany({ where: { planStatus: { in: ['ACTIVE', 'TRIALING'] }, planId: { not: null } }, include: { plan: true } }),
          nexora.prisma.platformInvoice.aggregate({ where: { status: 'PAID' }, _sum: { amountMinor: true } }),
          nexora.prisma.platformInvoice.aggregate({ where: { status: { in: ['PENDING', 'OVERDUE'] } }, _sum: { amountMinor: true } }),
          nexora.prisma.tenant.count({ where: { id: { notIn: ['default', 'platform'] } } }),
          nexora.prisma.tenant.count({ where: { createdAt: { gte: since30 }, id: { notIn: ['default', 'platform'] } } }),
          nexora.prisma.customer.count(),
          nexora.prisma.user.count(),
          nexora.prisma.subscription.count({ where: { status: { in: ['ACTIVE', 'FUP'] } } }),
          nexora.prisma.payment.aggregate({ where: { status: 'SUCCESS' }, _sum: { amountMinor: true } }),
        ]);
      const mrrMinor = planRevenue.reduce((sum, t) => sum + (t.plan?.priceMinor ?? 0), 0);

      // Top ISPs by revenue.
      const revByTenant = await nexora.prisma.payment.groupBy({
        by: ['tenantId'],
        where: { status: 'SUCCESS' },
        _sum: { amountMinor: true },
        _count: { _all: true },
      });
      const tenantNames = new Map(
        (await nexora.prisma.tenant.findMany({ select: { id: true, name: true, slug: true } })).map((t) => [t.id, t]),
      );
      const topIsps = revByTenant
        .filter((r) => r.tenantId !== 'platform')
        .sort((a, b) => (b._sum.amountMinor ?? 0) - (a._sum.amountMinor ?? 0))
        .slice(0, 8)
        .map((r) => ({
          tenantId: r.tenantId,
          name: tenantNames.get(r.tenantId)?.name ?? r.tenantId,
          slug: tenantNames.get(r.tenantId)?.slug ?? r.tenantId,
          revenueMinor: r._sum.amountMinor ?? 0,
          payments: r._count._all,
        }));

      return await reply.status(200).send({
        analytics: {
          tenants: tenantsTotal,
          newTenants30d: tenantsNew,
          customers,
          staff,
          activeSubscriptions: activeSubs,
          gmvMinor: gmv._sum.amountMinor ?? 0, // total ISP collections (platform-wide)
          platformRevenueMinor: platformCollected._sum.amountMinor ?? 0, // owner's collected subscription fees
          platformPendingMinor: platformPending._sum.amountMinor ?? 0,
          mrrMinor,
          planBreakdown: payingTenants.map((g) => ({ status: g.planStatus, count: g._count._all })),
          revenueSeries: [...byDay.entries()].map(([date, amountMinor]) => ({ date, amountMinor })),
          topIsps,
        },
      });
    },
  );

  // ---- Subscription plans (owner-managed catalogue) ----------------------
  const planSchema = z.object({
    code: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/),
    name: z.string().min(2).max(80),
    description: z.string().max(300).optional(),
    priceMinor: z.number().int().min(0),
    currency: z.string().length(3).optional(),
    interval: z.enum(['MONTHLY', 'YEARLY']).optional(),
    trialDays: z.number().int().min(0).max(365).optional(),
    maxStaff: z.number().int().positive().nullable().optional(),
    maxRouters: z.number().int().positive().nullable().optional(),
    maxCustomers: z.number().int().positive().nullable().optional(),
    features: z.array(z.string().max(120)).max(20).optional(),
    displayOrder: z.number().int().optional(),
    active: z.boolean().optional(),
  });

  app.get('/api/v1/platform/plans', { preHandler: [app.requirePlatformOwner] }, async (_request, reply) => {
    const plans = await nexora.prisma.subscriptionPlan.findMany({ orderBy: [{ displayOrder: 'asc' }, { priceMinor: 'asc' }] });
    const counts = await nexora.prisma.tenant.groupBy({ by: ['planId'], _count: { _all: true } });
    const byPlan = new Map(counts.map((c) => [c.planId, c._count._all]));
    return await reply.status(200).send({
      data: plans.map((p) => ({ ...p, subscribers: byPlan.get(p.id) ?? 0 })),
    });
  });

  app.post<{ Body: unknown }>('/api/v1/platform/plans', { preHandler: [app.requirePlatformOwner] }, async (request, reply) => {
    const input = parseOrThrow(planSchema, request.body, request.id);
    const existing = await nexora.prisma.subscriptionPlan.findUnique({ where: { code: input.code } });
    if (existing !== null) {
      return await reply.status(409).send({ error: { code: 'CONFLICT', message: 'A plan with that code exists.', correlationId: request.id, retryable: false } });
    }
    const plan = await nexora.prisma.subscriptionPlan.create({
      data: {
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        priceMinor: input.priceMinor,
        currency: input.currency ?? 'KES',
        interval: input.interval ?? 'MONTHLY',
        trialDays: input.trialDays ?? 14,
        maxStaff: input.maxStaff ?? null,
        maxRouters: input.maxRouters ?? null,
        maxCustomers: input.maxCustomers ?? null,
        features: input.features ?? [],
        displayOrder: input.displayOrder ?? 0,
        active: input.active ?? true,
      },
    });
    await writeAudit(nexora, { action: 'PLATFORM_PLAN_CREATED', resourceType: 'SubscriptionPlan', resourceId: plan.id, actor: request.principal, afterState: { code: plan.code, priceMinor: plan.priceMinor }, correlationId: request.id, ipAddress: request.ip });
    return await reply.status(201).send({ id: plan.id, code: plan.code });
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/v1/platform/plans/:id', { preHandler: [app.requirePlatformOwner] }, async (request, reply) => {
    const input = parseOrThrow(planSchema.partial(), request.body, request.id);
    const plan = await nexora.prisma.subscriptionPlan.findUnique({ where: { id: request.params.id } });
    if (plan === null) throw new NotFoundError('SubscriptionPlan', request.params.id, request.id);
    await nexora.prisma.subscriptionPlan.update({
      where: { id: plan.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.priceMinor !== undefined ? { priceMinor: input.priceMinor } : {}),
        ...(input.interval !== undefined ? { interval: input.interval } : {}),
        ...(input.trialDays !== undefined ? { trialDays: input.trialDays } : {}),
        ...(input.maxStaff !== undefined ? { maxStaff: input.maxStaff } : {}),
        ...(input.maxRouters !== undefined ? { maxRouters: input.maxRouters } : {}),
        ...(input.maxCustomers !== undefined ? { maxCustomers: input.maxCustomers } : {}),
        ...(input.features !== undefined ? { features: input.features } : {}),
        ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
    });
    await writeAudit(nexora, { action: 'PLATFORM_PLAN_UPDATED', resourceType: 'SubscriptionPlan', resourceId: plan.id, actor: request.principal, correlationId: request.id, ipAddress: request.ip });
    return await reply.status(200).send({ ok: true });
  });

  // Assign a plan to a company (starts a trial).
  app.put<{ Params: { id: string }; Body: unknown }>('/api/v1/platform/tenants/:id/plan', { preHandler: [app.requirePlatformOwner] }, async (request, reply) => {
    const input = parseOrThrow(z.object({ planId: z.string().uuid().nullable() }), request.body, request.id);
    const tenant = await nexora.prisma.tenant.findUnique({ where: { id: request.params.id } });
    if (tenant === null) throw new NotFoundError('Tenant', request.params.id, request.id);
    if (input.planId === null) {
      await nexora.prisma.tenant.update({ where: { id: tenant.id }, data: { planId: null, planStatus: 'CANCELLED' } });
      return await reply.status(200).send({ ok: true, planStatus: 'CANCELLED' });
    }
    const plan = await nexora.prisma.subscriptionPlan.findUnique({ where: { id: input.planId } });
    if (plan === null) throw new NotFoundError('SubscriptionPlan', input.planId, request.id);
    const now = new Date();
    const trialEnds = new Date(now.getTime() + plan.trialDays * 24 * 60 * 60 * 1000);
    await nexora.prisma.tenant.update({
      where: { id: tenant.id },
      data: { planId: plan.id, planStatus: 'TRIALING', trialEndsAt: trialEnds, currentPeriodEnd: trialEnds },
    });
    await createOutboxEvent(nexora, { eventType: 'TENANT_PLAN_ASSIGNED', aggregateType: 'Tenant', aggregateId: tenant.id, payload: { tenantId: tenant.id, planId: plan.id }, correlationId: request.id });
    await writeAudit(nexora, { action: 'TENANT_PLAN_ASSIGNED', resourceType: 'Tenant', resourceId: tenant.id, actor: request.principal, afterState: { planId: plan.id, planStatus: 'TRIALING' }, correlationId: request.id, ipAddress: request.ip });
    return await reply.status(200).send({ ok: true, planStatus: 'TRIALING', trialEndsAt: trialEnds.toISOString() });
  });

  // ---- Platform invoices (owner view) ------------------------------------
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/v1/platform/invoices', { preHandler: [app.requirePlatformOwner] }, async (request, reply) => {
    const page = Math.max(1, Number(request.query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 25)));
    const where = request.query.status !== undefined ? { status: request.query.status as never } : {};
    const [invoices, total] = await Promise.all([
      nexora.prisma.platformInvoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { tenant: { select: { name: true, slug: true } }, plan: { select: { name: true } } },
      }),
      nexora.prisma.platformInvoice.count({ where }),
    ]);
    return await reply.status(200).send({
      data: invoices.map((i) => ({
        id: i.id, number: i.number, company: i.tenant.name, slug: i.tenant.slug, plan: i.plan?.name ?? null,
        amountMinor: i.amountMinor, currency: i.currency, status: i.status,
        periodStart: i.periodStart.toISOString(), periodEnd: i.periodEnd.toISOString(), dueDate: i.dueDate.toISOString(),
        paidAt: i.paidAt?.toISOString() ?? null, receipt: i.receipt, createdAt: i.createdAt.toISOString(),
      })),
      page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  });

  // Run the billing cycle now (also runs on the scheduler).
  app.post('/api/v1/platform/billing/run', { preHandler: [app.requirePlatformOwner] }, async (request, reply) => {
    const result = await runPlatformBillingCycle(nexora.prisma);
    await writeAudit(nexora, { action: 'PLATFORM_BILLING_RUN', resourceType: 'System', resourceId: 'billing', actor: request.principal, afterState: result, correlationId: request.id, ipAddress: request.ip });
    return await reply.status(200).send({ ok: true, ...result });
  });

  // ---- Platform (owner) M-Pesa payment configuration ---------------------
  const platformPayCfg = z.object({
    channel: z.enum(['PAYBILL', 'TILL']),
    env: z.enum(['sandbox', 'production']).default('sandbox'),
    shortcode: z.string().min(3).max(12),
    partyB: z.string().min(3).max(12).optional(),
    consumerKey: z.string().min(1).optional(),
    consumerSecret: z.string().min(1).optional(),
    passkey: z.string().min(1).optional(),
    callbackUrl: z.string().url().optional(),
  });

  app.get('/api/v1/platform/payment-config', { preHandler: [app.requirePlatformOwner] }, async (_request, reply) => {
    const t = await nexora.prisma.tenant.findUniqueOrThrow({ where: { id: 'platform' } });
    return await reply.status(200).send({
      payment: {
        channel: t.mpesaChannel, environment: t.mpesaEnv, shortcode: t.mpesaShortcode, partyB: t.mpesaPartyB,
        callbackUrl: t.mpesaCallbackUrl,
        credentialsConfigured: t.mpesaConsumerKeyEnc !== null && t.mpesaConsumerSecretEnc !== null && t.mpesaPasskeyEnc !== null,
        configuredAt: t.mpesaConfiguredAt?.toISOString() ?? null,
        encryptionAvailable: nexora.env.CREDENTIALS_ENCRYPTION_KEY !== undefined,
      },
    });
  });

  app.put<{ Body: unknown }>('/api/v1/platform/payment-config', { preHandler: [app.requirePlatformOwner] }, async (request, reply) => {
    const input = parseOrThrow(platformPayCfg, request.body, request.id);
    const key = nexora.env.CREDENTIALS_ENCRYPTION_KEY;
    const wantsCreds = input.consumerKey !== undefined || input.consumerSecret !== undefined || input.passkey !== undefined;
    if (wantsCreds && (key === undefined || key.length === 0)) {
      return await reply.status(409).send({ error: { code: 'ENCRYPTION_UNAVAILABLE', message: 'Set CREDENTIALS_ENCRYPTION_KEY before storing M-Pesa credentials.', correlationId: request.id, retryable: false } });
    }
    const data: Record<string, unknown> = {
      mpesaChannel: input.channel, mpesaEnv: input.env, mpesaShortcode: input.shortcode, mpesaPartyB: input.partyB ?? null,
      ...(input.callbackUrl !== undefined ? { mpesaCallbackUrl: input.callbackUrl } : {}),
    };
    if (wantsCreds && key !== undefined) {
      if (input.consumerKey !== undefined) data.mpesaConsumerKeyEnc = encryptSecret(input.consumerKey, key);
      if (input.consumerSecret !== undefined) data.mpesaConsumerSecretEnc = encryptSecret(input.consumerSecret, key);
      if (input.passkey !== undefined) data.mpesaPasskeyEnc = encryptSecret(input.passkey, key);
      data.mpesaConfiguredAt = new Date();
    }
    await nexora.prisma.tenant.update({ where: { id: 'platform' }, data });
    await createOutboxEvent(nexora, { eventType: 'PLATFORM_PAYMENT_CONFIGURED', aggregateType: 'Tenant', aggregateId: 'platform', payload: { channel: input.channel, shortcode: input.shortcode }, correlationId: request.id });
    await writeAudit(nexora, { action: 'PLATFORM_PAYMENT_CONFIGURED', resourceType: 'Tenant', resourceId: 'platform', actor: request.principal, afterState: { channel: input.channel, credentialsUpdated: wantsCreds }, correlationId: request.id, ipAddress: request.ip });
    return await reply.status(200).send({ ok: true });
  });

  // ---- AI operations-monitor insights ------------------------------------
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/v1/platform/insights', { preHandler: [app.requirePlatformOwner] }, async (request, reply) => {
    const status = request.query.status ?? 'OPEN';
    const insights = await nexora.prisma.platformInsight.findMany({
      where: status === 'ALL' ? {} : { status: status as never },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
      include: { tenant: { select: { name: true, slug: true } } },
    });
    return await reply.status(200).send({
      data: insights.map((i) => ({
        id: i.id, code: i.code, severity: i.severity, category: i.category, title: i.title, detail: i.detail,
        metrics: i.metrics, company: i.tenant?.name ?? null, status: i.status, createdAt: i.createdAt.toISOString(),
      })),
    });
  });

  app.post('/api/v1/platform/monitor/run', { preHandler: [app.requirePlatformOwner] }, async (request, reply) => {
    const result = await runMonitorCycle(nexora.prisma);
    await writeAudit(nexora, { action: 'PLATFORM_MONITOR_RUN', resourceType: 'System', resourceId: 'monitor', actor: request.principal, afterState: { created: result.insightsCreated }, correlationId: request.id, ipAddress: request.ip });
    return await reply.status(200).send({ ok: true, signalsFound: result.signalsFound, insightsCreated: result.insightsCreated });
  });

  app.post<{ Params: { id: string } }>('/api/v1/platform/insights/:id/ack', { preHandler: [app.requirePlatformOwner] }, async (request, reply) => {
    const insight = await nexora.prisma.platformInsight.findUnique({ where: { id: request.params.id } });
    if (insight === null) throw new NotFoundError('PlatformInsight', request.params.id, request.id);
    await nexora.prisma.platformInsight.update({
      where: { id: insight.id },
      data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), acknowledgedBy: request.principal!.subjectId },
    });
    return await reply.status(200).send({ ok: true });
  });
}
