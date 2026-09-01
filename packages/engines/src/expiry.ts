/**
 * Expiry engine (§21): scheduled evaluation of `now >= expiryTime` —
 * EXPIRED transition, desired-state revocation, DEAUTHORIZE operation,
 * active session termination, outbox + audit. Payment state is never
 * touched (invariants #3, #7).
 */

import type { PrismaClient } from '@prisma/client';
import { subscriptionMachine } from '@nexora/domain';

export interface ExpiryCycleResult {
  readonly expired: number;
  readonly subscriptionIds: string[];
}

export function isExpirable(status: string, expiryTime: Date | null, now: Date): boolean {
  return (
    (status === 'ACTIVE' || status === 'FUP' || status === 'SUSPENDED' || status === 'PROVISIONING_FAILED') &&
    expiryTime !== null &&
    expiryTime.getTime() <= now.getTime()
  );
}

export async function runExpiryCycle(prisma: PrismaClient): Promise<ExpiryCycleResult> {
  const now = new Date();
  const due = await prisma.subscription.findMany({
    where: {
      status: { in: ['ACTIVE', 'FUP', 'SUSPENDED', 'PROVISIONING_FAILED'] },
      expiryTime: { lte: now },
    },
    include: { networkPolicy: true },
  });

  const expiredIds: string[] = [];

  for (const subscription of due) {
    if (!isExpirable(subscription.status, subscription.expiryTime, now)) continue;

    await prisma.$transaction(async (tx) => {
      subscriptionMachine.assertTransition(subscription.status, 'EXPIRED');
      await tx.subscription.update({
        where: { id: subscription.id },
        data: { status: 'EXPIRED' },
      });

      // Desired state: revoke (version bump).
      if (subscription.networkPolicy !== null) {
        const desired = subscription.networkPolicy.desiredState as {
          macAddress: string | null;
          authorized: boolean;
          rateLimit: { downloadKbps: number; uploadKbps: number } | null;
          sessionTimeLimitSeconds?: number | null;
        };
        await tx.networkPolicy.update({
          where: { subscriptionId: subscription.id },
          data: {
            desiredState: { ...desired, authorized: false, rateLimit: null },
            version: { increment: 1 },
          },
        });

        const router = await tx.router.findFirst({
          where: { status: { not: 'OFFLINE' } },
          orderBy: { createdAt: 'asc' },
        });
        if (router !== null && desired.macAddress !== null) {
          await tx.networkOperation.create({
            data: {
              routerId: router.id,
              customerId: subscription.customerId,
              subscriptionId: subscription.id,
              operationType: 'DEAUTHORIZE',
              desiredState: { ...desired, authorized: false, rateLimit: null },
              status: 'QUEUED',
              idempotencyKey: `deauthorize:${subscription.id}:${now.getTime()}`,
              correlationId: `expiry-${subscription.id}-${now.getTime()}`,
            },
          });
        }
      }

      // Terminate active sessions.
      await tx.customerSession.updateMany({
        where: { subscriptionId: subscription.id, status: { in: ['ONLINE', 'THROTTLED', 'AUTHORIZED'] } },
        data: { status: 'ENDED', endedAt: now, terminationReason: 'SUBSCRIPTION_EXPIRED' },
      });

      await tx.outboxEvent.create({
        data: {
          eventType: 'SUBSCRIPTION_EXPIRED',
          aggregateType: 'Subscription',
          aggregateId: subscription.id,
          payload: { subscriptionId: subscription.id, customerId: subscription.customerId },
          correlationId: `expiry-${subscription.id}-${now.getTime()}`,
        },
      });

      await tx.auditLog.create({
        data: {
          actorType: 'SYSTEM',
          action: 'SUBSCRIPTION_EXPIRED',
          resourceType: 'Subscription',
          resourceId: subscription.id,
          beforeState: { status: subscription.status },
          afterState: { status: 'EXPIRED' },
          correlationId: `expiry-${subscription.id}-${now.getTime()}`,
        },
      });
    });

    expiredIds.push(subscription.id);
  }

  return { expired: expiredIds.length, subscriptionIds: expiredIds };
}
