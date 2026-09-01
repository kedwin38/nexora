/**
 * NEXORA worker service entry point.
 *
 * Consumes outbox events and job queues (Stage 6). This Stage 1 shell proves
 * the service boots, validates configuration, connects to PostgreSQL, and
 * exits gracefully — the deployment topology exists from day one.
 */

import { databaseEnvSchema, parseEnv } from '@nexora/config';
import { createLogger } from '@nexora/logging';
import { createPrismaClient, disposePrismaClient } from '@nexora/db';

async function main(): Promise<void> {
  const env = parseEnv(databaseEnvSchema);
  const logger = createLogger({ service: 'worker', level: env.LOG_LEVEL });
  const prisma = createPrismaClient();

  await prisma.$queryRaw`SELECT 1`;
  logger.info('Worker started; queue consumers arrive in Stage 6', { env: env.APP_ENV });

  const heartbeat = setInterval(() => {
    logger.debug('Worker heartbeat');
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
  console.error('Fatal worker boot error:', error);
  process.exit(1);
});
