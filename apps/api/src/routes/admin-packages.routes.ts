/**
 * Admin package management (§4.2, §55) with version-aware updates:
 * edits create a NEW version (old row retired) so active subscriptions keep
 * their immutable policy snapshots — history is never rewritten (§111).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '@nexora/domain';
import type { NexoraContext } from '../context.js';
import { writeAudit } from '../plugins/auth.js';

const policySchema = z.object({
  downloadKbps: z.number().int().positive(),
  uploadKbps: z.number().int().positive(),
  burstDownloadKbps: z.number().int().positive().nullable().optional(),
  burstUploadKbps: z.number().int().positive().nullable().optional(),
  fupLimitBytes: z.string().regex(/^\d+$/).nullable().optional(), // decimal string (BigInt wire format)
  fupWarningPercent: z.number().int().min(1).max(100).optional(),
  fupThrottleDownloadKbps: z.number().int().positive().nullable().optional(),
  fupThrottleUploadKbps: z.number().int().positive().nullable().optional(),
  fupResetPolicy: z.enum(['NONE', 'DAILY', 'WEEKLY', 'MONTHLY', 'PERIOD']).optional(),
  sessionTimeLimitSeconds: z.number().int().positive().nullable().optional(),
});

const packageCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  priceMinor: z.number().int().positive(),
  currency: z.string().length(3).optional(),
  durationSeconds: z.number().int().positive(),
  maxDevices: z.number().int().positive().default(1),
  displayOrder: z.number().int().optional(),
  policy: policySchema,
});

const packageUpdateSchema = packageCreateSchema.partial();

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, body: unknown, requestId: string): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Request validation failed.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, requestId);
  }
  return parsed.data;
}

export async function registerAdminPackageRoutes(app: FastifyInstance, nexora: NexoraContext): Promise<void> {
  app.get(
    '/api/v1/admin/packages',
    { preHandler: [app.requirePermission('package.read')] },
    async (_request, reply) => {
      const packages = await nexora.prisma.package.findMany({
        orderBy: [{ status: 'asc' }, { displayOrder: 'asc' }, { version: 'desc' }],
        include: { policy: true },
      });
      return await reply.status(200).send({
        data: packages.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          version: p.version,
          status: p.status,
          priceMinor: p.priceMinor,
          currency: p.currency,
          durationSeconds: p.durationSeconds,
          maxDevices: p.maxDevices,
          displayOrder: p.displayOrder,
          policy: p.policy === null ? null : {
            downloadKbps: p.policy.downloadKbps,
            uploadKbps: p.policy.uploadKbps,
            fupLimitBytes: p.policy.fupLimitBytes?.toString() ?? null,
            fupWarningPercent: p.policy.fupWarningPercent,
            fupThrottleDownloadKbps: p.policy.fupThrottleDownloadKbps,
            fupThrottleUploadKbps: p.policy.fupThrottleUploadKbps,
            fupResetPolicy: p.policy.fupResetPolicy,
          },
        })),
      });
    },
  );

  app.post<{ Body: unknown }>(
    '/api/v1/admin/packages',
    { preHandler: [app.requirePermission('package.write')] },
    async (request, reply) => {
      const input = parseOrThrow(packageCreateSchema, request.body, request.id);
      const pkg = await nexora.prisma.$transaction(async (tx) => {
        const existing = await tx.package.findFirst({
          where: { tenantId: 'default', name: input.name },
          orderBy: { version: 'desc' },
        });
        const created = await tx.package.create({
          data: {
            name: input.name,
            ...(input.description !== undefined ? { description: input.description } : {}),
            priceMinor: input.priceMinor,
            ...(input.currency !== undefined ? { currency: input.currency } : {}),
            durationSeconds: input.durationSeconds,
            maxDevices: input.maxDevices,
            ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
            version: (existing?.version ?? 0) + 1,
            status: 'ACTIVE',
          },
        });
        await tx.packagePolicy.create({
          data: {
            packageId: created.id,
            downloadKbps: input.policy.downloadKbps,
            uploadKbps: input.policy.uploadKbps,
            ...(input.policy.burstDownloadKbps !== undefined ? { burstDownloadKbps: input.policy.burstDownloadKbps } : {}),
            ...(input.policy.burstUploadKbps !== undefined ? { burstUploadKbps: input.policy.burstUploadKbps } : {}),
            ...(input.policy.fupLimitBytes !== undefined && input.policy.fupLimitBytes !== null
              ? { fupLimitBytes: BigInt(input.policy.fupLimitBytes) }
              : {}),
            ...(input.policy.fupWarningPercent !== undefined ? { fupWarningPercent: input.policy.fupWarningPercent } : {}),
            ...(input.policy.fupThrottleDownloadKbps !== undefined ? { fupThrottleDownloadKbps: input.policy.fupThrottleDownloadKbps } : {}),
            ...(input.policy.fupThrottleUploadKbps !== undefined ? { fupThrottleUploadKbps: input.policy.fupThrottleUploadKbps } : {}),
            ...(input.policy.fupResetPolicy !== undefined ? { fupResetPolicy: input.policy.fupResetPolicy } : {}),
            ...(input.policy.sessionTimeLimitSeconds !== undefined ? { sessionTimeLimitSeconds: input.policy.sessionTimeLimitSeconds } : {}),
          },
        });
        return created;
      });
      await writeAudit(nexora, {
        action: 'PACKAGE_CREATED',
        resourceType: 'Package',
        resourceId: pkg.id,
        actor: request.principal,
        afterState: { name: pkg.name, version: pkg.version, priceMinor: pkg.priceMinor },
        correlationId: request.id,
        ipAddress: request.ip,
      });
      return await reply.status(201).send({ id: pkg.id, name: pkg.name, version: pkg.version });
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/admin/packages/:id',
    { preHandler: [app.requirePermission('package.write')] },
    async (request, reply) => {
      const input = parseOrThrow(packageUpdateSchema, request.body, request.id);
      const current = await nexora.prisma.package.findUnique({ where: { id: request.params.id }, include: { policy: true } });
      if (current === null) throw new NotFoundError('Package', request.params.id, request.id);

      // Version-aware update: clone as vN+1, retire the old row (§4.2/§111).
      const created = await nexora.prisma.$transaction(async (tx) => {
        await tx.package.update({ where: { id: current.id }, data: { status: 'RETIRED' } });
        const next = await tx.package.create({
          data: {
            name: input.name ?? current.name,
            description: input.description ?? current.description,
            priceMinor: input.priceMinor ?? current.priceMinor,
            currency: input.currency ?? current.currency,
            durationSeconds: input.durationSeconds ?? current.durationSeconds,
            maxDevices: input.maxDevices ?? current.maxDevices,
            displayOrder: input.displayOrder ?? current.displayOrder,
            version: current.version + 1,
            status: 'ACTIVE',
          },
        });
        await tx.packagePolicy.create({
          data: {
            packageId: next.id,
            downloadKbps: input.policy?.downloadKbps ?? current.policy?.downloadKbps ?? 2048,
            uploadKbps: input.policy?.uploadKbps ?? current.policy?.uploadKbps ?? 1024,
            burstDownloadKbps: input.policy?.burstDownloadKbps ?? current.policy?.burstDownloadKbps ?? null,
            burstUploadKbps: input.policy?.burstUploadKbps ?? current.policy?.burstUploadKbps ?? null,
            fupLimitBytes:
              input.policy?.fupLimitBytes !== undefined
                ? input.policy.fupLimitBytes === null || input.policy.fupLimitBytes === undefined
                  ? null
                  : BigInt(input.policy.fupLimitBytes)
                : current.policy?.fupLimitBytes ?? null,
            fupWarningPercent: input.policy?.fupWarningPercent ?? current.policy?.fupWarningPercent ?? 80,
            fupThrottleDownloadKbps: input.policy?.fupThrottleDownloadKbps ?? current.policy?.fupThrottleDownloadKbps ?? null,
            fupThrottleUploadKbps: input.policy?.fupThrottleUploadKbps ?? current.policy?.fupThrottleUploadKbps ?? null,
            fupResetPolicy: input.policy?.fupResetPolicy ?? current.policy?.fupResetPolicy ?? 'NONE',
            sessionTimeLimitSeconds: input.policy?.sessionTimeLimitSeconds ?? current.policy?.sessionTimeLimitSeconds ?? null,
          },
        });
        return next;
      });

      await writeAudit(nexora, {
        action: 'PACKAGE_VERSIONED',
        resourceType: 'Package',
        resourceId: created.id,
        actor: request.principal,
        beforeState: { packageId: current.id, version: current.version },
        afterState: { packageId: created.id, version: created.version },
        correlationId: request.id,
        ipAddress: request.ip,
      });
      return await reply.status(201).send({ id: created.id, name: created.name, version: created.version, supersedes: current.id });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/admin/packages/:id',
    { preHandler: [app.requirePermission('package.write')] },
    async (request, reply) => {
      const pkg = await nexora.prisma.package.findUnique({ where: { id: request.params.id } });
      if (pkg === null) throw new NotFoundError('Package', request.params.id, request.id);
      await nexora.prisma.package.update({ where: { id: pkg.id }, data: { status: 'RETIRED' } });
      await writeAudit(nexora, {
        action: 'PACKAGE_RETIRED',
        resourceType: 'Package',
        resourceId: pkg.id,
        actor: request.principal,
        afterState: { status: 'RETIRED' },
        correlationId: request.id,
        ipAddress: request.ip,
      });
      return await reply.status(200).send({ ok: true });
    },
  );
}
