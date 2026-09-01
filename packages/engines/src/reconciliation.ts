/**
 * Reconciliation engine (§26–§27): desired (DB) vs actual (router) comparison,
 * drift detection and repair, health polling.
 *
 *   read actual -> compare desired -> drift? repair op + event : mark synchronized
 */

import type { PrismaClient } from '@prisma/client';
import type { RouterAdapter } from '@nexora/router-sdk';

export interface ReconciliationCycleResult {
  readonly routerId: string;
  readonly checked: number;
  readonly drifted: number;
  readonly repaired: number;
  readonly unreachable: boolean;
}

export async function runReconciliationCycle(
  prisma: PrismaClient,
  routerId: string,
  adapter: RouterAdapter,
): Promise<ReconciliationCycleResult> {
  const now = new Date();
  let checked = 0;
  let drifted = 0;
  let repaired = 0;

  const policies = await prisma.networkPolicy.findMany({
    include: { subscription: true },
    take: 200,
  });

  for (const policy of policies) {
    const desired = policy.desiredState as {
      macAddress: string | null;
      authorized: boolean;
      rateLimit: { downloadKbps: number; uploadKbps: number } | null;
      sessionTimeLimitSeconds?: number | null;
    };
    if (desired.macAddress === null) continue; // nothing to reconcile against yet
    checked += 1;

    try {
      const report = await adapter.reconcileSubscriber({
        macAddress: desired.macAddress,
        authorized: desired.authorized,
        rateLimit:
          desired.rateLimit === null
            ? null
            : { downloadKbps: desired.rateLimit.downloadKbps, uploadKbps: desired.rateLimit.uploadKbps, burstDownloadKbps: null, burstUploadKbps: null },
        sessionTimeLimitSeconds: desired.sessionTimeLimitSeconds ?? null,
      });

      const matches =
        desired.authorized === false
          ? report.subscriberState === null || report.subscriberState.authorized === false
          : report.matchesDesired === true;

      if (matches) {
        await prisma.networkPolicy.update({
          where: { subscriptionId: policy.subscriptionId },
          data: { synchronizedAt: now },
        });
        continue;
      }

      drifted += 1;
      await prisma.networkOperation.create({
        data: {
          routerId,
          customerId: policy.subscription.customerId,
          subscriptionId: policy.subscriptionId,
          operationType: 'RECONCILE_SYNC',
          desiredState: desired,
          status: 'QUEUED',
          idempotencyKey: `reconcile:${policy.subscriptionId}:${policy.version}-${now.getTime()}`,
          correlationId: `reconcile-${policy.subscriptionId}-${now.getTime()}`,
        },
      }).catch(() => undefined); // duplicate idempotency key = repair already queued
      repaired += 1;

      await prisma.outboxEvent.create({
        data: {
          eventType: 'NETWORK_DRIFT_DETECTED',
          aggregateType: 'Subscription',
          aggregateId: policy.subscriptionId,
          payload: { subscriptionId: policy.subscriptionId, desiredVersion: policy.version },
          correlationId: `reconcile-${policy.subscriptionId}-${now.getTime()}`,
        },
      });
    } catch {
      // Adapter failure for one subscriber must not abort the cycle.
      continue;
    }
  }

  return { routerId, checked, drifted, repaired, unreachable: false };
}

export interface RouterHealthResult {
  readonly routerId: string;
  readonly status: 'ONLINE' | 'DEGRADED' | 'OFFLINE';
  readonly statusChanged: boolean;
}

export async function runRouterHealthCheck(
  prisma: PrismaClient,
  routerId: string,
  adapter: RouterAdapter,
): Promise<RouterHealthResult> {
  const router = await prisma.router.findUnique({ where: { id: routerId } });
  if (router === null) throw new Error(`Router ${routerId} not found`);

  let next: 'ONLINE' | 'DEGRADED' | 'OFFLINE' = 'OFFLINE';
  try {
    const health = await adapter.healthCheck();
    next = health.online ? 'ONLINE' : 'OFFLINE';
  } catch {
    next = 'OFFLINE';
  }

  const changed = router.status !== next;
  await prisma.router.update({
    where: { id: routerId },
    data: {
      status: next,
      lastSeenAt: next === 'ONLINE' ? new Date() : router.lastSeenAt,
      healthPayload: { checkedAt: new Date().toISOString(), status: next },
    },
  });

  if (changed) {
    await prisma.outboxEvent.create({
      data: {
        eventType: next === 'ONLINE' ? 'ROUTER_ONLINE' : 'ROUTER_OFFLINE',
        aggregateType: 'Router',
        aggregateId: routerId,
        payload: { routerId, from: router.status, to: next },
        correlationId: `health-${routerId}-${Date.now()}`,
      },
    });
  }

  return { routerId, status: next, statusChanged: changed };
}
