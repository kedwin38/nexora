/**
 * NEXORA worker (§6.3): two loops.
 *
 * 1. Outbox dispatcher — PENDING OutboxEvents → DISPATCHED + SystemEvent trail.
 * 2. Job runner — claims DB-bound job types (subscription-expiry,
 *    fup-evaluation, session-cleanup) and executes the corresponding engine.
 *    Router-bound jobs belong to network-worker.
 */

import { databaseEnvSchema, parseEnv } from '@nexora/config';
import { createLogger, type Logger } from '@nexora/logging';
import { createPrismaClient, disposePrismaClient, type PrismaClient } from '@nexora/db';
import {
  createNotificationsFromOutbox,
  deliverPendingNotifications,
  LogNotificationSender,
  runExpiryCycle,
  runFupEvaluationCycle,
  runPaymentReconciliation,
} from '@nexora/engines';
import { MockPaymentProvider, MpesaDarajaProvider, type PaymentProvider } from '@nexora/payment-sdk';
import { mpesaEnvSchema } from '@nexora/config';

const OUTBOX_POLL_MS = 2_000;
const JOB_POLL_MS = 3_000;
const NOTIFY_POLL_MS = 5_000;
const OUTBOX_BATCH = 50;
const JOB_TYPES = ['subscription-expiry', 'fup-evaluation', 'session-cleanup', 'payment-reconciliation'] as const;

function buildPaymentProvider(): PaymentProvider {
  if (process.env.PAYMENT_PROVIDER === 'mpesa') {
    const env = parseEnv(mpesaEnvSchema);
    return new MpesaDarajaProvider({
      env: env.MPESA_ENV,
      consumerKey: env.MPESA_CONSUMER_KEY,
      consumerSecret: env.MPESA_CONSUMER_SECRET,
      shortcode: env.MPESA_SHORTCODE,
      passkey: env.MPESA_PASSKEY,
      callbackUrl: env.MPESA_CALLBACK_URL,
    });
  }
  return new MockPaymentProvider();
}

async function claimJob(prisma: PrismaClient): Promise<{ id: string; type: string } | null> {
  const job = await prisma.job.findFirst({
    where: { type: { in: [...JOB_TYPES] }, status: 'QUEUED', runAfter: { lte: new Date() } },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' },
    ],
  });
  if (job === null) return null;
  const claimed = await prisma.job.updateMany({
    where: { id: job.id, status: 'QUEUED' },
    data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 }, workerId: 'worker' },
  });
  return claimed.count === 1 ? { id: job.id, type: job.type } : null;
}

async function executeJob(prisma: PrismaClient, logger: Logger, job: { id: string; type: string }): Promise<void> {
  let result: string;
  try {
    switch (job.type) {
      case 'subscription-expiry': {
        const summary = await runExpiryCycle(prisma);
        result = `expired=${summary.expired}`;
        break;
      }
      case 'fup-evaluation': {
        const summary = await runFupEvaluationCycle(prisma);
        result = `evaluated=${summary.evaluated} transitions=${summary.transitions.length}`;
        break;
      }
      case 'session-cleanup': {
        const cutoff = new Date(Date.now() - 24 * 3_600_000);
        const stale = await prisma.customerSession.updateMany({
          where: { status: { in: ['ONLINE', 'THROTTLED'] }, lastSeenAt: { lt: cutoff } },
          data: { status: 'ENDED', endedAt: new Date(), terminationReason: 'STALE_CLEANUP' },
        });
        result = `staleEnded=${stale.count}`;
        break;
      }
      case 'payment-reconciliation': {
        const summary = await runPaymentReconciliation(prisma, buildPaymentProvider());
        result = `checked=${summary.checked} confirmed=${summary.confirmed} failed=${summary.failed} pending=${summary.stillPending} errors=${summary.providerErrors}`;
        break;
      }
      default:
        throw new Error(`Worker cannot execute job type '${job.type}'`);
    }
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'SUCCESS', completedAt: new Date(), result },
    });
    logger.info('Job SUCCESS', { jobId: job.id, type: job.type, result });
  } catch (error) {
    const job1 = await prisma.job.findUnique({ where: { id: job.id } });
    const attempts = job1?.attempts ?? 1;
    const exhausted = attempts >= (job1?.maxAttempts ?? 3);
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: exhausted ? 'FAILED' : 'RETRYING',
        lastError: (error as Error).message.slice(0, 500),
        ...(exhausted ? {} : { runAfter: new Date(Date.now() + 2 ** attempts * 1000) }),
      },
    });
    logger.error('Job FAILED', { jobId: job.id, type: job.type, error: (error as Error).message, exhausted });
  }
}

async function main(): Promise<void> {
  const env = parseEnv(databaseEnvSchema);
  const logger = createLogger({ service: 'worker', level: env.LOG_LEVEL });
  const prisma = createPrismaClient();

  await prisma.$queryRaw`SELECT 1`;
  logger.info('Worker started — outbox dispatcher + job runner', { env: env.APP_ENV });

  let running = true;

  async function dispatchOutbox(): Promise<void> {
    const due = await prisma.outboxEvent.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: OUTBOX_BATCH,
    });
    const dispatchedEvents: Array<{ id: string; eventType: string; aggregateType: string; aggregateId: string; payload: unknown; correlationId: string }> = [];
    for (const event of due) {
      try {
        await prisma.$transaction([
          prisma.outboxEvent.update({
            where: { id: event.id },
            data: { status: 'DISPATCHED', dispatchedAt: new Date(), attempts: { increment: 1 } },
          }),
          prisma.systemEvent.create({
            data: {
              eventType: event.eventType,
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              payload: event.payload as object,
              status: 'PROCESSED',
              correlationId: event.correlationId,
              // The originating outbox row, for traceability (schema §28).
              causationId: event.id,
              processedAt: new Date(),
            },
          }),
        ]);
        dispatchedEvents.push(event);
      } catch (error) {
        const attempts = event.attempts + 1;
        const dead = attempts >= event.maxAttempts;
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: dead ? 'DEAD' : 'PENDING',
            attempts,
            lastError: (error as Error).message.slice(0, 500),
            nextAttemptAt: new Date(Date.now() + Math.min(2 ** attempts * 1000, 300_000)),
          },
        });
        logger.warn('Outbox dispatch failed', {
          eventId: event.id,
          eventType: event.eventType,
          attempts,
          dead,
          error: (error as Error).message,
        });
      }
    }
    // Fan dispatched events into notifications (§62) — never blocks dispatch.
    if (dispatchedEvents.length > 0) {
      await createNotificationsFromOutbox(prisma, dispatchedEvents).catch((error: unknown) => {
        logger.warn('Notification fan-out failed', { error: (error as Error).message });
      });
    }
  }

  const notificationSender = new LogNotificationSender();
  async function deliverNotifications(): Promise<void> {
    const result = await deliverPendingNotifications(prisma, notificationSender);
    if (result.sent > 0 || result.failed > 0) {
      logger.info('Notification delivery', { sent: result.sent, failed: result.failed });
    }
  }

  const outboxLoop = setInterval(() => {
    if (!running) return;
    void dispatchOutbox().catch((error: unknown) => {
      logger.error('Outbox dispatcher cycle failed', { error: (error as Error).message });
    });
  }, OUTBOX_POLL_MS);

  const jobLoop = setInterval(() => {
    if (!running) return;
    void claimJob(prisma)
      .then((job) => (job === null ? undefined : executeJob(prisma, logger, job)))
      .catch((error: unknown) => {
        logger.error('Job runner cycle failed', { error: (error as Error).message });
      });
  }, JOB_POLL_MS);

  const notifyLoop = setInterval(() => {
    if (!running) return;
    void deliverNotifications().catch((error: unknown) => {
      logger.error('Notification delivery cycle failed', { error: (error as Error).message });
    });
  }, NOTIFY_POLL_MS);

  const shutdown = async (signal: string): Promise<void> => {
    running = false;
    clearInterval(outboxLoop);
    clearInterval(jobLoop);
    clearInterval(notifyLoop);
    logger.info('Shutting down', { signal });
    await disposePrismaClient();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((error: unknown) => {
  console.error('Fatal worker boot error:', error);
  process.exit(1);
});
