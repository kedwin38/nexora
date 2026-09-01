/**
 * Public package catalog (§54): GET /api/v1/packages — guests may browse.
 */

import type { FastifyInstance } from 'fastify';
import type { NexoraContext } from '../context.js';

export async function registerPackageRoutes(app: FastifyInstance, nexora: NexoraContext): Promise<void> {
  app.get('/api/v1/packages', async (_request, reply) => {
    const packages = await nexora.prisma.package.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { displayOrder: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        currency: true,
        priceMinor: true,
        durationSeconds: true,
        maxDevices: true,
        policy: {
          select: {
            downloadKbps: true,
            uploadKbps: true,
            fupLimitBytes: true,
            fupThrottleDownloadKbps: true,
            fupThrottleUploadKbps: true,
          },
        },
      },
    });

    return await reply.status(200).send({
      data: packages.map((pkg) => ({
        id: pkg.id,
        name: pkg.name,
        description: pkg.description,
        priceMinor: pkg.priceMinor,
        currency: pkg.currency,
        durationSeconds: pkg.durationSeconds,
        maxDevices: pkg.maxDevices,
        speed: pkg.policy === null ? null : { downKbps: pkg.policy.downloadKbps, upKbps: pkg.policy.uploadKbps },
        fup: pkg.policy === null || pkg.policy.fupLimitBytes === null
          ? null
          : {
              limitBytes: pkg.policy.fupLimitBytes.toString(),
              throttleDownKbps: pkg.policy.fupThrottleDownloadKbps,
              throttleUpKbps: pkg.policy.fupThrottleUploadKbps,
            },
      })),
    });
  });
}
