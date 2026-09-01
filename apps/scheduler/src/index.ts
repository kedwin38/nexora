/**
 * NEXORA scheduler (§6.5): periodic cycles enqueue Job rows — cron triggers
 * work, it never becomes the domain engine (invariant #11). Workers claim
 * jobs by type:
 *
 *   worker          -> subscription-expiry, fup-evaluation, session-cleanup
 *   network-worker  -> usage-sync, network-reconciliation, router-health
 */

import { databaseEnvSchema, parseEnv } from '@nexora/config';
import { createLogger } from '@nexora/logging';
import { createPrismaClient, disposePrismaClient } from '@nexora/db';

const TICK_SECONDS_DEFAULT = 60;

async function main(): Promise<void> {
  const env = parseEnv(databaseEnvSchema);
  const logger = createLogger({ service: 'scheduler', level: env.LOG_LEVEL });
  const prisma = createPrismaClient();
  const tickMs = (Number(process.env.SCHEDULER_TICK_SECONDS ?? TICK_SECONDS_DEFAULT) || TICK_SECONDS_DEFAULT) * 1000;

  await prisma.$queryRaw`SELECT 1`;
  logger.info('Scheduler started — enqueueing job records', { env: env.APP_ENV, tickMs });

  const enqueue = (type: string, cronExpression: string): void => {
    void prisma.job
      .create({
        data: {
          type,
          payload: { cron: cronExpression },
          status: 'QUEUED',
          runAfter: new Date(),
          priority: type === 'router-health' ? 5 : 0,
        },
      })
      .then(() => logger.debug('Job enqueued', { type }))
      .catch((error: unknown) => {
        // Duplicate-dedupe is handled by the guard below; log anything else.
        logger.warn('Job enqueue failed', { type, error: (error as Error).message });
      });
  };

  const guard = async (type: string): Promise<boolean> => {
    const pending = await prisma.job.count({
      where: { type, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    return pending === 0;
  };

  let running = true;
  const cycle = async (): Promise<void> => {
    const types: Array<[string, string]> = [
      ['subscription-expiry', '*/5 * * * *'],
      ['fup-evaluation', '*/5 * * * *'],
      ['session-cleanup', '0 * * * *'],
      ['usage-sync', '*/1 * * * *'],
      ['network-reconciliation', '*/5 * * * *'],
      ['router-health', '*/1 * * * *'],
    ];
    for (const [type, cron] of types) {
      if (!running) break;
      if (await guard(type)) enqueue(type, cron);
    }
  };

  await cycle(); // immediate first tick
  const loop = setInterval(() => {
    if (!running) return;
    void cycle().catch((error: unknown) => {
      logger.error('Scheduler cycle failed', { error: (error as Error).message });
    });
  }, tickMs);

  const shutdown = async (signal: string): Promise<void> => {
    running = false;
    clearInterval(loop);
    logger.info('Shutting down', { signal });
    await disposePrismaClient();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((error: unknown) => {
  console.error('Fatal scheduler boot error:', error);
  process.exit(1);
});
