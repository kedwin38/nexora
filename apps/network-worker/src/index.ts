/**
 * NEXORA network-worker service entry point.
 *
 * Executes durable NetworkOperations against routers via adapters, with
 * read-back verification and bounded retries (Stage 4). Stage 1 shell proves
 * boot + configuration + graceful shutdown. Router credentials are read from
 * environment variables referenced by the Router registry (ADR-008) — they
 * are never stored in the database.
 */

import { databaseEnvSchema, parseEnv } from '@nexora/config';
import { createLogger } from '@nexora/logging';
import { createPrismaClient, disposePrismaClient } from '@nexora/db';

async function main(): Promise<void> {
  const env = parseEnv(databaseEnvSchema);
  const logger = createLogger({ service: 'network-worker', level: env.LOG_LEVEL });
  const prisma = createPrismaClient();

  await prisma.$queryRaw`SELECT 1`;
  logger.info('Network worker started; operation executor arrives in Stage 4', {
    env: env.APP_ENV,
  });

  const heartbeat = setInterval(() => {
    logger.debug('Network worker heartbeat');
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
  console.error('Fatal network-worker boot error:', error);
  process.exit(1);
});
