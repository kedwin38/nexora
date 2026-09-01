/**
 * NEXORA API service entry point.
 *
 * The only public business entry point (architecture map §6.2). Boots Fastify,
 * registers health routes and the global error envelope, and shuts down
 * gracefully on SIGTERM/SIGINT (Railway sends SIGTERM on redeploy).
 */

import Fastify from 'fastify';
import { apiEnvSchema, parseEnv } from '@nexora/config';
import { createLogger } from '@nexora/logging';
import { registerHealthRoutes } from './health.js';
import { registerErrorHandler } from './errors.js';

async function main(): Promise<void> {
  const env = parseEnv(apiEnvSchema);
  const logger = createLogger({ service: 'api', level: env.LOG_LEVEL });
  const startupTime = new Date();

  const app = Fastify({
    logger: false,
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
  });

  await registerHealthRoutes(app, { serviceName: 'api', startupTime });
  registerErrorHandler(app, logger);

  // Correlation ID on every response.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
  });

  // Request access logging (structured, redacted).
  app.addHook('onResponse', async (request, reply) => {
    logger.info('request', {
      correlationId: request.id,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime.toFixed(1),
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutting down', { signal });
    try {
      await app.close();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('Shutdown failed', { error: (error as Error).message });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    logger.info('API listening', { port: env.PORT, host: env.HOST, env: env.APP_ENV });
  } catch (error) {
    logger.fatal('Failed to start API', { error: (error as Error).message });
    process.exit(1);
  }
}

void main();
