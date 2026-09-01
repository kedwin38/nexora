/**
 * NEXORA API service entry point (§6.2).
 *
 * Boots Fastify with the full /api/v1 surface, serves the interim operator
 * portal from /public, wires ports to implementations, and shuts down
 * gracefully on SIGTERM/SIGINT.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import { apiEnvSchema, mpesaEnvSchema, parseEnv } from '@nexora/config';
import { createLogger } from '@nexora/logging';
import { Argon2PasswordHasher, HmacTokenService } from '@nexora/auth';
import { MockPaymentProvider, MpesaDarajaProvider } from '@nexora/payment-sdk';
import { MikroTikAdapter, MockRouterAdapter, type RouterAdapter } from '@nexora/router-sdk';
import { createPrismaClient, disposePrismaClient } from '@nexora/db';
import { registerHealthRoutes } from './health.js';
import { registerErrorHandler } from './errors.js';
import { createMetrics } from './metrics.js';
import { registerAuthPlugin } from './plugins/auth.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerCustomerRoutes } from './routes/customer.routes.js';
import { registerPackageRoutes } from './routes/package.routes.js';
import { registerPaymentRoutes } from './routes/payment.routes.js';
import { registerWebhookRoutes } from './routes/webhook.routes.js';
import { registerAdminRoutes } from './routes/admin.routes.js';
import { registerAdminPackageRoutes } from './routes/admin-packages.routes.js';
import { registerAdminUserRoutes } from './routes/admin-users.routes.js';
import { registerAdminOpsRoutes } from './routes/admin-ops.routes.js';
import { registerGuestRoutes } from './routes/guest.routes.js';
import { prismaSessionStore } from './session-store.js';
import type { NexoraContext } from './context.js';

async function loadPortalHtml(): Promise<string | null> {
  // Works under tsx dev (cwd = apps/api), node dist (cwd = apps/api), and
  // repo-root invocations. import.meta.url is unavailable in CJS bundles,
  // so cwd-based resolution is the portable choice.
  const candidates = [
    join(process.cwd(), 'public', 'index.html'),
    join(process.cwd(), 'apps', 'api', 'public', 'index.html'),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8');
    } catch {
      // try next
    }
  }
  return null;
}

async function main(): Promise<void> {
  const env = parseEnv(apiEnvSchema);
  const logger = createLogger({ service: 'api', level: env.LOG_LEVEL });
  const startupTime = new Date();
  const prisma = createPrismaClient();

  // ---- Port wiring (composition root) ----
  const hasher = new Argon2PasswordHasher();
  const tokens = new HmacTokenService({
    secret: env.SESSION_SECRET,
    sessionStore: prismaSessionStore(prisma),
    ttlSeconds: env.SESSION_TTL_HOURS * 3600,
  });

  const payments =
    env.PAYMENT_PROVIDER === 'mpesa'
      ? new MpesaDarajaProvider({
          env: parseEnv(mpesaEnvSchema).MPESA_ENV,
          consumerKey: parseEnv(mpesaEnvSchema).MPESA_CONSUMER_KEY,
          consumerSecret: parseEnv(mpesaEnvSchema).MPESA_CONSUMER_SECRET,
          shortcode: parseEnv(mpesaEnvSchema).MPESA_SHORTCODE,
          passkey: parseEnv(mpesaEnvSchema).MPESA_PASSKEY,
          callbackUrl: parseEnv(mpesaEnvSchema).MPESA_CALLBACK_URL,
        })
      : new MockPaymentProvider();

  const mockRouter = env.ROUTER_ADAPTER === 'mock' ? new MockRouterAdapter() : null;
  const routers: NexoraContext['routers'] = {
    get: async (routerId: string): Promise<RouterAdapter> => {
      if (mockRouter !== null) return mockRouter;
      const router = await prisma.router.findUniqueOrThrow({ where: { id: routerId } });
      const password = process.env[router.passwordEnvVar];
      if (password === undefined || password.length === 0) {
        throw new Error(`Router secret '${router.passwordEnvVar}' is not set (ADR-008).`);
      }
      return new MikroTikAdapter(
        {
          host: router.host,
          port: router.port,
          username: router.username,
          passwordEnvVar: router.passwordEnvVar,
          timeoutMs: 10_000,
        },
        password,
      );
    },
  };

  const metrics = createMetrics(prisma);

  const nexora: NexoraContext = { env, logger, prisma, hasher, tokens, payments, metrics, routers };

  // ---- HTTP server ----
  const app = Fastify({
    logger: false,
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  await app.register(cors, { origin: env.CORS_ORIGIN });
  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
  });

  // Correlation ID on every response + request access logging (hooks must be
  // registered before routes to apply to them).
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    metrics.httpRequestDuration(
      { method: request.method, route: request.routeOptions?.url ?? 'unmatched', status: reply.statusCode },
      reply.elapsedTime / 1000,
    );
    logger.info('request', {
      correlationId: request.id,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime.toFixed(1),
    });
  });

  app.get('/metrics', async (_request, reply) => {
    return await reply
      .type(metrics.registry.contentType)
      .send(await metrics.registry.metrics());
  });

  // Root endpoint
  app.get('/', async (_request, reply) => {
    return await reply.status(200).send({
      message: 'Nexora API is online',
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  await registerHealthRoutes(app, { serviceName: 'api', startupTime });
  registerErrorHandler(app, logger);
  await registerAuthPlugin(app, nexora);
  await registerAuthRoutes(app, nexora);
  await registerCustomerRoutes(app, nexora);
  await registerPackageRoutes(app, nexora);
  await registerPaymentRoutes(app, nexora);
  await registerWebhookRoutes(app, nexora);
  await registerAdminRoutes(app, nexora);
  await registerAdminPackageRoutes(app, nexora);
  await registerAdminUserRoutes(app, nexora);
  await registerAdminOpsRoutes(app, nexora);
  await registerGuestRoutes(app, nexora);

  // ---- Interim operator portal (Stage 7 replaces this with apps/web) ----
  const portalHtml = await loadPortalHtml();
  if (portalHtml !== null) {
    const portalPaths = new Set(['/', '/auth/login', '/auth/customer', '/dashboard', '/packages', '/guest', '/admin', '/admin/ops']);
    app.get('*', async (request, reply) => {
      if (portalPaths.has(request.url.split('?')[0] ?? '')) {
        return await reply.type('text/html').send(portalHtml);
      }
      return await reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} does not exist.`, correlationId: request.id, retryable: false },
      });
    });
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutting down', { signal });
    try {
      await app.close();
      await disposePrismaClient();
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
    logger.info('NEXORA API listening', {
      port: env.PORT,
      env: env.APP_ENV,
      paymentProvider: env.PAYMENT_PROVIDER,
      routerAdapter: env.ROUTER_ADAPTER,
    });
  } catch (error) {
    logger.fatal('Failed to start API', { error: (error as Error).message });
    process.exit(1);
  }
}

void main();
