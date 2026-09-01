/**
 * Usage engine (§19, §22): converts router counters into business consumption.
 *
 * One cycle per router: read active sessions + counters via the adapter,
 * reconcile the CustomerSession table (auto-create ONLINE sessions for newly
 * seen MACs — AAA accounting-lite for Phase 1; end sessions the router no
 * longer reports), then compute byte deltas with rollover protection and
 * accumulate into sessions, FUP usage and hourly UsageRecords.
 */

import type { PrismaClient } from '@prisma/client';
import type { RouterAdapter } from '@nexora/router-sdk';

export interface DeltaResult {
  readonly delta: bigint;
  readonly resetSuspected: boolean;
}

/** Pure: monotonic counter delta with rollover/reset protection. */
export function computeDelta(previous: bigint | null, current: bigint | null): DeltaResult {
  if (current === null) return { delta: 0n, resetSuspected: false };
  if (previous === null) return { delta: 0n, resetSuspected: false }; // first observation — establish baseline
  if (current < previous) return { delta: 0n, resetSuspected: true }; // counter reset/rollover
  return { delta: current - previous, resetSuspected: false };
}

export interface UsageCycleResult {
  readonly routerId: string;
  readonly sessionsSeen: number;
  readonly sessionsCreated: number;
  readonly sessionsEnded: number;
  readonly bytesAccounted: bigint;
}

export async function runUsageSyncCycle(
  prisma: PrismaClient,
  routerId: string,
  adapter: RouterAdapter,
): Promise<UsageCycleResult> {
  const active = await adapter.getActiveSessions();
  const now = new Date();
  let created = 0;
  let ended = 0;
  let accounted = 0n;

  const seenMacs = new Set(active.map((s) => s.macAddress.toUpperCase()));

  // Auto-create sessions for devices online on the router with an eligible subscription.
  for (const routerSession of active) {
    const mac = routerSession.macAddress.toUpperCase();
    const device = await prisma.device.findFirst({
      where: { macAddress: mac },
      orderBy: { lastSeenAt: 'desc' },
      include: {
        customer: {
          include: {
            subscriptions: {
              where: { status: { in: ['ACTIVE', 'FUP'] } },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    });
    const subscription = device?.customer.subscriptions[0] ?? null;
    if (device === null || subscription === null) continue; // unknown or unauthorized device — not our session

    const existing = await prisma.customerSession.findFirst({
      where: { macAddress: mac, status: { in: ['ONLINE', 'THROTTLED'] } },
      orderBy: { startedAt: 'desc' },
    });

    if (existing === undefined || existing === null) {
      await prisma.customerSession.create({
        data: {
          customerId: device.customerId,
          subscriptionId: subscription.id,
          routerId,
          deviceId: device.id,
          macAddress: mac,
          ipAddress: routerSession.ipAddress,
          status: 'ONLINE',
          startedAt: now,
          lastSeenAt: now,
        },
      });
      created += 1;
    } else {
      await prisma.customerSession.update({
        where: { id: existing.id },
        data: { lastSeenAt: now, ...(routerSession.ipAddress !== null ? { ipAddress: routerSession.ipAddress } : {}) },
      });
    }
  }

  // End sessions the router no longer reports (Phase 1 timeout semantics).
  const dbOnline = await prisma.customerSession.findMany({
    where: { status: { in: ['ONLINE', 'THROTTLED'] }, routerId },
  });
  for (const session of dbOnline) {
    if (!seenMacs.has(session.macAddress.toUpperCase())) {
      await prisma.customerSession.update({
        where: { id: session.id },
        data: { status: 'ENDED', endedAt: now, terminationReason: 'ROUTER_TIMEOUT' },
      });
      ended += 1;
    }
  }

  // Counter deltas → session bytes + FUP + hourly aggregation.
  const onlineSessions = await prisma.customerSession.findMany({
    where: { status: { in: ['ONLINE', 'THROTTLED'] }, routerId },
    include: { subscription: { include: { fupStates: { orderBy: { periodStart: 'desc' }, take: 1 } } } },
  });

  for (const session of onlineSessions) {
    const usage = await adapter.getUsage(session.macAddress);
    const lastSnapshot = await prisma.usageSnapshot.findFirst({
      where: { macAddress: session.macAddress },
      orderBy: { collectedAt: 'desc' },
    });

    const down = computeDelta(lastSnapshot?.counterDownload ?? null, BigInt(usage.downloadBytes ?? 0));
    const up = computeDelta(lastSnapshot?.counterUpload ?? null, BigInt(usage.uploadBytes ?? 0));

    await prisma.usageSnapshot.create({
      data: {
        routerId,
        sessionId: session.id,
        macAddress: session.macAddress,
        counterDownload: BigInt(usage.downloadBytes ?? 0),
        counterUpload: BigInt(usage.uploadBytes ?? 0),
        counterResetSuspected: down.resetSuspected || up.resetSuspected || usage.counterResetSuspected,
        collectedAt: now,
      },
    });

    const deltaBytes = down.delta + up.delta;
    if (deltaBytes > 0n) {
      accounted += deltaBytes;
      await prisma.customerSession.update({
        where: { id: session.id },
        data: { downloadBytes: { increment: down.delta }, uploadBytes: { increment: up.delta } },
      });

      const fup = session.subscription.fupStates[0];
      if (fup !== undefined) {
        await prisma.fupState.update({
          where: { id: fup.id },
          data: { usedBytes: { increment: deltaBytes }, lastEvaluatedAt: now },
        });
      }

      // Hourly aggregation (§64 read model).
      const hourStart = new Date(now);
      hourStart.setMinutes(0, 0, 0);
      const hourEnd = new Date(hourStart.getTime() + 3_600_000);
      const existingRecord = await prisma.usageRecord.findFirst({
        where: { sessionId: session.id, intervalStart: hourStart },
        select: { id: true },
      });
      if (existingRecord !== null) {
        await prisma.usageRecord.update({
          where: { id: existingRecord.id },
          data: {
            downloadBytes: { increment: down.delta },
            uploadBytes: { increment: up.delta },
            intervalEnd: hourEnd,
          },
        });
      } else {
        await prisma.usageRecord.create({
          data: {
            sessionId: session.id,
            subscriptionId: session.subscriptionId,
            customerId: session.customerId,
            intervalStart: hourStart,
            intervalEnd: hourEnd,
            downloadBytes: down.delta,
            uploadBytes: up.delta,
            source: 'ROUTER',
          },
        });
      }
    }
  }

  return {
    routerId,
    sessionsSeen: active.length,
    sessionsCreated: created,
    sessionsEnded: ended,
    bytesAccounted: accounted,
  };
}
