/**
 * FUP engine (§20): policy-transition engine. Evaluates usage against the
 * subscription period limit and, on transitions, updates business state,
 * bumps the desired network state (versioned) and queues APPLY_POLICY /
 * restore network operations. Pure transition mapping is unit-tested.
 */

import type { PrismaClient } from '@prisma/client';
import {
  evaluateFupState,
  fupMachine,
  resolveEffectiveRateLimit,
  subscriptionMachine,
  type FupStatus,
  type PackagePolicySnapshot,
} from '@nexora/domain';

export interface FupEvaluation {
  readonly subscriptionId: string;
  readonly from: FupStatus;
  readonly to: FupStatus;
  readonly usedBytes: string;
  readonly limitBytes: string | null;
}

export interface FupCycleResult {
  readonly evaluated: number;
  readonly transitions: FupEvaluation[];
}

export async function runFupEvaluationCycle(prisma: PrismaClient): Promise<FupCycleResult> {
  const now = new Date();
  const fupStates = await prisma.fupState.findMany({
    where: { state: { in: ['NORMAL', 'WARNING', 'FUP_REACHED', 'THROTTLED'] }, periodEnd: { gt: now } },
    include: {
      subscription: {
        include: { networkPolicy: true, networkOperations: { orderBy: { createdAt: 'desc' }, take: 1 } },
      },
    },
  });

  const transitions: FupEvaluation[] = [];

  for (const fup of fupStates) {
    const next = evaluateFupState({
      current: fup.state as FupStatus,
      usedBytes: fup.usedBytes,
      limitBytes: fup.limitBytes,
      warningPercent: fup.warningPercent,
    });
    if (next === fup.state) {
      await prisma.fupState.update({ where: { id: fup.id }, data: { lastEvaluatedAt: now } });
      continue;
    }

    fupMachine.assertTransition(fup.state as FupStatus, next);
    const evaluation: FupEvaluation = {
      subscriptionId: fup.subscriptionId,
      from: fup.state as FupStatus,
      to: next,
      usedBytes: fup.usedBytes.toString(),
      limitBytes: fup.limitBytes.toString(),
    };

    const policy = fup.subscription.policySnapshot as unknown as PackagePolicySnapshot;
    const throttled = next === 'THROTTLED';

    await prisma.$transaction(async (tx) => {
      await tx.fupState.update({
        where: { id: fup.id },
        data: { state: next, lastEvaluatedAt: now, ...(next === 'NORMAL' ? { usedBytes: 0n, resetAt: now } : {}) },
      });

      if (throttled) {
        subscriptionMachine.assertTransition(fup.subscription.status, 'FUP');
        await tx.subscription.update({
          where: { id: fup.subscriptionId },
          data: { status: 'FUP' },
        });
      } else if (next === 'NORMAL' && fup.subscription.status === 'FUP') {
        subscriptionMachine.assertTransition(fup.subscription.status, 'ACTIVE');
        await tx.subscription.update({
          where: { id: fup.subscriptionId },
          data: { status: 'ACTIVE' },
        });
      }

      // Desired network state bump (versioned, §20 output) — only when
      // enforced speeds actually change (throttle applied or restored);
      // WARNING transitions are informational only.
      const speedChange = next === 'THROTTLED' || (next === 'NORMAL' && fup.state === 'THROTTLED');
      const currentPolicy = fup.subscription.networkPolicy;
      if (currentPolicy !== null && speedChange) {
        const desired = currentPolicy.desiredState as {
          macAddress: string | null;
          authorized: boolean;
          rateLimit: { downloadKbps: number; uploadKbps: number } | null;
          sessionTimeLimitSeconds?: number | null;
        };
        const effective = resolveEffectiveRateLimit(
          {
            downloadKbps: policy.downloadKbps,
            uploadKbps: policy.uploadKbps,
            burstDownloadKbps: null,
            burstUploadKbps: null,
            fupThrottleDownloadKbps: policy.fupThrottleDownloadKbps ?? null,
            fupThrottleUploadKbps: policy.fupThrottleUploadKbps ?? null,
            sessionTimeLimitSeconds: null,
          },
          { fupStatus: next, subscriptionSuspended: false, authorized: desired.authorized },
        );
        const rateLimit =
          effective.downloadKbps === 0 && effective.uploadKbps === 0
            ? null
            : { downloadKbps: effective.downloadKbps, uploadKbps: effective.uploadKbps };

        await tx.networkPolicy.update({
          where: { subscriptionId: fup.subscriptionId },
          data: {
            desiredState: { ...desired, rateLimit },
            version: { increment: 1 },
          },
        });

        const router = await tx.router.findFirst({
          where: { status: { not: 'OFFLINE' } },
          orderBy: { createdAt: 'asc' },
        });
        if (router !== null) {
          await tx.networkOperation.create({
            data: {
              routerId: router.id,
              customerId: fup.subscription.customerId,
              subscriptionId: fup.subscriptionId,
              operationType: 'APPLY_POLICY',
              desiredState: { ...desired, rateLimit },
              status: 'QUEUED',
              idempotencyKey: `apply-policy:${fup.subscriptionId}:fup-${next.toLowerCase()}-${now.getTime()}`,
              correlationId: `fup-${fup.subscriptionId}-${now.getTime()}`,
            },
          });
        }
      }

      await tx.outboxEvent.create({
        data: {
          // NORMAL→FUP_RESET, WARNING→FUP_WARNING, FUP_REACHED→FUP_REACHED, THROTTLED→FUP_THROTTLED
          eventType: next === 'NORMAL' ? 'FUP_RESET' : `FUP_${next}`,
          aggregateType: 'Subscription',
          aggregateId: fup.subscriptionId,
          payload: { subscriptionId: fup.subscriptionId, from: fup.state, to: next },
          correlationId: `fup-${fup.subscriptionId}-${now.getTime()}`,
        },
      });
    });

    transitions.push(evaluation);
  }

  return { evaluated: fupStates.length, transitions };
}

/** Admin command: force-reset FUP for a subscription (§4.4). */
export async function resetFupForSubscription(
  prisma: PrismaClient,
  subscriptionId: string,
  correlationId: string,
): Promise<void> {
  const fup = await prisma.fupState.findFirst({
    where: { subscriptionId },
    orderBy: { periodStart: 'desc' },
  });
  if (fup === null) throw new Error(`No FUP state for subscription ${subscriptionId}`);

  fupMachine.assertTransition(fup.state as FupStatus, 'NORMAL');
  await runFupEvaluationReset(prisma, fup.id, subscriptionId, correlationId);
}

async function runFupEvaluationReset(
  prisma: PrismaClient,
  fupId: string,
  subscriptionId: string,
  correlationId: string,
): Promise<void> {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.fupState.update({
      where: { id: fupId },
      data: { state: 'NORMAL', usedBytes: 0n, resetAt: now, lastEvaluatedAt: now },
    });
    const sub = await tx.subscription.findUnique({ where: { id: subscriptionId } });
    if (sub !== null && sub.status === 'FUP') {
      subscriptionMachine.assertTransition(sub.status, 'ACTIVE');
      await tx.subscription.update({ where: { id: subscriptionId }, data: { status: 'ACTIVE' } });
    }
    await tx.outboxEvent.create({
      data: {
        eventType: 'FUP_RESET',
        aggregateType: 'Subscription',
        aggregateId: subscriptionId,
        payload: { subscriptionId, actor: 'admin' },
        correlationId,
      },
    });
  });
}
