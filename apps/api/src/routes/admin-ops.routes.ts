/**
 * Admin operations surface (§4.1, §4.4, §4.5):
 *  - Customer detail with the three explicitly separated states
 *    (Business / Desired Network / Actual Network) + drift verdict.
 *  - Payment configuration status (presence booleans, never secret values)
 *    and reconciliation trigger.
 *  - Manual network reconciliation trigger.
 */

import type { FastifyInstance } from 'fastify';
import { NotFoundError } from '@nexora/domain';
import type { NexoraContext } from '../context.js';
import { writeAudit } from '../plugins/auth.js';

export async function registerAdminOpsRoutes(app: FastifyInstance, nexora: NexoraContext): Promise<void> {
  // ---- Customer detail: the 3-pane support workspace (§60) ----
  app.get<{ Params: { id: string } }>(
    '/api/v1/admin/customers/:id',
    { preHandler: [app.requirePermission('customer.read')] },
    async (request, reply) => {
      const customer = await nexora.prisma.customer.findUnique({
        where: { id: request.params.id },
        include: {
          devices: true,
          guestAccess: true,
          subscriptions: {
            orderBy: { createdAt: 'desc' },
            take: 5,
            include: {
              package: { select: { name: true, version: true } },
              fupStates: { orderBy: { periodStart: 'desc' }, take: 1 },
              networkPolicy: true,
            },
          },
          payments: { orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, status: true, amountMinor: true, receipt: true, createdAt: true } },
        },
      });
      if (customer === null) throw new NotFoundError('Customer', request.params.id, request.id);

      const sub = customer.subscriptions[0] ?? null;
      const desired = sub?.networkPolicy?.desiredState ?? null;

      // Actual network state = the latest operation's verified read-back.
      const lastOp = sub !== null
        ? await nexora.prisma.networkOperation.findFirst({
            where: { subscriptionId: sub.id },
            orderBy: { createdAt: 'desc' },
          })
        : null;
      const actual = (lastOp?.verificationResult as { matchesDesired?: boolean | null } | null) ?? null;

      const sessions = await nexora.prisma.customerSession.findMany({
        where: { customerId: customer.id },
        orderBy: { startedAt: 'desc' },
        take: 5,
      });

      return await reply.status(200).send({
        business: {
          customer: {
            id: customer.id,
            customerNumber: customer.customerNumber,
            accountType: customer.accountType,
            status: customer.status,
            phone: customer.phoneNumber,
            displayName: customer.displayName,
            createdAt: customer.createdAt.toISOString(),
          },
          subscription: sub === null ? null : {
            id: sub.id,
            subscriptionNumber: sub.subscriptionNumber,
            status: sub.status,
            packageName: sub.package.name,
            packageVersion: sub.package.version,
            expiryTime: sub.expiryTime?.toISOString() ?? null,
            fup: sub.fupStates[0]
              ? { state: sub.fupStates[0].state, usedBytes: sub.fupStates[0].usedBytes.toString(), limitBytes: sub.fupStates[0].limitBytes.toString() }
              : null,
          },
          payments: customer.payments.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
        },
        desiredNetworkState: sub?.networkPolicy
          ? { version: sub.networkPolicy.version, state: desired, synchronizedAt: sub.networkPolicy.synchronizedAt?.toISOString() ?? null }
          : null,
        actualNetworkState: lastOp === null
          ? null
          : {
              lastOperation: { type: lastOp.operationType, status: lastOp.status, verifiedAt: lastOp.completedAt?.toISOString() ?? null },
              matchesDesired: actual?.matchesDesired ?? null,
            },
        driftVerdict:
          sub?.networkPolicy == null
            ? 'UNKNOWN'
            : sub.networkPolicy.synchronizedAt == null
              ? 'PENDING_VERIFICATION'
              : (actual?.matchesDesired ?? null) === true
                ? 'SYNCHRONIZED'
                : (actual?.matchesDesired ?? null) === false
                  ? 'DRIFTED'
                  : 'SYNCHRONIZED',
        devices: customer.devices.map((d) => ({ macAddress: d.macAddress, lastSeenAt: d.lastSeenAt.toISOString() })),
        sessions: sessions.map((s) => ({
          macAddress: s.macAddress,
          status: s.status,
          startedAt: s.startedAt.toISOString(),
          endedAt: s.endedAt?.toISOString() ?? null,
          terminationReason: s.terminationReason,
        })),
      });
    },
  );

  // ---- Payment configuration status (§4.1) — booleans only, never values ----
  app.get(
    '/api/v1/admin/payment-config',
    { preHandler: [app.requirePermission('payment.config.manage')] },
    async (_request, reply) => {
      const env = process.env;
      return await reply.status(200).send({
        provider: nexora.env.PAYMENT_PROVIDER,
        daraja: {
          configured:
            env.MPESA_CONSUMER_KEY !== undefined && env.MPESA_CONSUMER_KEY.length > 0 &&
            env.MPESA_CONSUMER_SECRET !== undefined && env.MPESA_CONSUMER_SECRET.length > 0 &&
            env.MPESA_SHORTCODE !== undefined && env.MPESA_SHORTCODE.length > 0 &&
            env.MPESA_PASSKEY !== undefined && env.MPESA_PASSKEY.length > 0,
          environment: env.MPESA_ENV ?? 'sandbox',
          callbackUrl: env.MPESA_CALLBACK_URL ?? null,
        },
        note: 'Secrets live in Railway Variables (ADR-008) — rotate there; this view only reports presence.',
      });
    },
  );

  // ---- Manual triggers (§4.4) ----
  const enqueueJob = async (type: string, correlationId: string): Promise<void> => {
    await nexora.prisma.job.create({
      data: { type, payload: { source: 'admin' }, status: 'QUEUED', correlationId },
    });
  };

  app.post(
    '/api/v1/admin/payment-config/reconcile',
    { preHandler: [app.requirePermission('payment.reconciliation.run')] },
    async (request, reply) => {
      await enqueueJob('payment-reconciliation', request.id);
      await writeAudit(nexora, {
        action: 'PAYMENT_RECONCILIATION_TRIGGERED',
        resourceType: 'System',
        resourceId: 'payments',
        actor: request.principal,
        correlationId: request.id,
        ipAddress: request.ip,
      });
      return await reply.status(202).send({ ok: true, queued: 'payment-reconciliation' });
    },
  );

  app.post(
    '/api/v1/admin/network/reconcile',
    { preHandler: [app.requirePermission('router.manage')] },
    async (request, reply) => {
      await enqueueJob('network-reconciliation', request.id);
      await writeAudit(nexora, {
        action: 'NETWORK_RECONCILIATION_TRIGGERED',
        resourceType: 'System',
        resourceId: 'network',
        actor: request.principal,
        correlationId: request.id,
        ipAddress: request.ip,
      });
      return await reply.status(202).send({ ok: true, queued: 'network-reconciliation' });
    },
  );
}
