/**
 * Health endpoints (architecture map §51; persona build step 37).
 *
 * /health/live — process is up; no dependency checks.
 * /health/ready — dependencies (PostgreSQL) reachable; used by Railway
 * deployment health checks.
 */

import type { FastifyInstance } from 'fastify';
import type { HealthLiveBody, HealthReadyBody } from '@nexora/contracts';
import { createPrismaClient, disposePrismaClient } from '@nexora/db';

export interface HealthOptions {
  readonly serviceName: string;
  readonly startupTime: Date;
}

interface DependencyProbe {
  name: string;
  probe: () => Promise<boolean>;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  options: HealthOptions,
): Promise<void> {
  const prisma = createPrismaClient();
  const probes: DependencyProbe[] = [
    { name: 'postgres', probe: async () => (await prisma.$queryRaw`SELECT 1`) !== undefined },
  ];

  app.get<{ Reply: HealthLiveBody }>('/health/live', async (_request, reply) => {
    return await reply.status(200).send({
      status: 'ok',
      service: options.serviceName,
      uptimeSeconds: Math.floor((Date.now() - options.startupTime.getTime()) / 1000),
    });
  });

  app.get<{ Reply: HealthReadyBody }>('/health/ready', async (_request, reply) => {
    const results = await Promise.all(
      probes.map(async (dep) => {
        try {
          return { name: dep.name, up: await dep.probe() };
        } catch {
          return { name: dep.name, up: false };
        }
      }),
    );

    const dependencies: HealthReadyBody['dependencies'] = {};
    for (const result of results) {
      dependencies[result.name] = { status: result.up ? 'up' : 'down' };
    }
    const allUp = results.every((r) => r.up);

    return await reply.status(allUp ? 200 : 503).send({
      status: allUp ? 'ok' : 'degraded',
      service: options.serviceName,
      dependencies,
      checkedAt: new Date().toISOString(),
    });
  });

  app.addHook('onClose', async () => {
    await disposePrismaClient();
  });
}
