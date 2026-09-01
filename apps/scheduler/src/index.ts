/**
 * NEXORA scheduler service entry point.
 *
 * Periodically enqueues job records — cron triggers work, it never contains
 * domain logic (invariant #11). The cron definitions (subscription-expiry,
 * fup-evaluation, usage-sync, router-health, network-reconciliation,
 * payment-reconciliation, notification-retry, session-cleanup) arrive in
 * Stage 8. Stage 1 shell proves boot + DB connectivity + graceful shutdown.
 */

import { databaseEnvSchema, parseEnv } from '@nexora/config';
import { createLogger } from '@nexora/logging';
import { createPrismaClient, disposePrismaClient } from '@nexora/db';

async function main(): Promise<void> {
  const env = parseEnv(databaseEnvSchema);
  const logger = createLogger({ service: 'scheduler', level: env.LOG_LEVEL });
  const prisma = createPrismaClient();

  await prisma.$queryRaw`SELECT 1`;
  logger.info('Scheduler started; cron definitions arrive in Stage 8', { env: env.APP_ENV });

  const heartbeat = setInterval(() => {
    logger.debug('Scheduler heartbeat');
  }, 60_000);
  heartbeat.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutting down', { signal });
    clearInterval(heartbeat);
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
