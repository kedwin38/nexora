/**
 * Admin user & role management (§4.3, §55): create staff users, assign
 * roles, disable accounts, force session invalidation. Every mutation is
 * audited; no user may escalate outside this audited workflow.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '@nexora/domain';
import { ROLES, type Role } from '@nexora/auth';
import type { NexoraContext } from '../context.js';
import { writeAudit } from '../plugins/auth.js';

const userCreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10, 'Staff passwords must be at least 10 characters'),
  displayName: z.string().min(1).max(100),
  role: z.enum(ROLES as unknown as [Role, ...Role[]]),
});

const userUpdateSchema = z.object({
  role: z.enum(ROLES as unknown as [Role, ...Role[]]).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  displayName: z.string().min(1).max(100).optional(),
});

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, body: unknown, requestId: string): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Request validation failed.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, requestId);
  }
  return parsed.data;
}

export async function registerAdminUserRoutes(app: FastifyInstance, nexora: NexoraContext): Promise<void> {
  app.get(
    '/api/v1/admin/users',
    { preHandler: [app.requirePermission('user.read')] },
    async (_request, reply) => {
      const users = await nexora.prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
          role: { select: { name: true } },
        },
      });
      return await reply.status(200).send({
        data: users.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          status: u.status,
          role: u.role.name,
          lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
          createdAt: u.createdAt.toISOString(),
        })),
      });
    },
  );

  app.get(
    '/api/v1/admin/roles',
    { preHandler: [app.requirePermission('user.read')] },
    async (_request, reply) => {
      const roles = await nexora.prisma.role.findMany({
        orderBy: { name: 'asc' },
        include: { permissions: { include: { permission: true } } },
      });
      return await reply.status(200).send({
        data: roles.map((r) => ({
          name: r.name,
          permissions: r.permissions.map((p) => p.permission.key).sort(),
        })),
      });
    },
  );

  app.post<{ Body: unknown }>(
    '/api/v1/admin/users',
    { preHandler: [app.requirePermission('user.write')] },
    async (request, reply) => {
      const input = parseOrThrow(userCreateSchema, request.body, request.id);
      const existing = await nexora.prisma.user.findUnique({ where: { email: input.email } });
      if (existing !== null) {
        return await reply.status(409).send({
          error: { code: 'CONFLICT', message: 'User already exists.', correlationId: request.id, retryable: false },
        });
      }
      const role = await nexora.prisma.role.findUnique({ where: { name: input.role } });
      if (role === null) throw new NotFoundError('Role', input.role, request.id);

      const passwordHash = await nexora.hasher.hash(input.password);
      const user = await nexora.prisma.user.create({
        data: { email: input.email, passwordHash, displayName: input.displayName, roleId: role.id },
      });
      await writeAudit(nexora, {
        action: 'USER_CREATED',
        resourceType: 'User',
        resourceId: user.id,
        actor: request.principal,
        afterState: { email: user.email, role: role.name },
        correlationId: request.id,
        ipAddress: request.ip,
      });
      return await reply.status(201).send({ id: user.id, email: user.email, role: role.name });
    },
  );

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/admin/users/:id',
    { preHandler: [app.requirePermission('user.write')] },
    async (request, reply) => {
      const input = parseOrThrow(userUpdateSchema, request.body, request.id);
      const user = await nexora.prisma.user.findUnique({ where: { id: request.params.id }, include: { role: true } });
      if (user === null) throw new NotFoundError('User', request.params.id, request.id);

      const before = { role: user.role.name, status: user.status, displayName: user.displayName };
      const roleId = input.role !== undefined
        ? (await nexora.prisma.role.findUniqueOrThrow({ where: { name: input.role } })).id
        : undefined;

      const updated = await nexora.prisma.user.update({
        where: { id: user.id },
        data: {
          ...(roleId !== undefined ? { roleId } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        },
        include: { role: true },
      });

      // Disabling an account invalidates all its sessions immediately.
      if (input.status === 'DISABLED') {
        await nexora.prisma.userSession.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      // Role changes invalidate sessions so new permissions apply on next login.
      if (roleId !== undefined) {
        await nexora.prisma.userSession.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      await writeAudit(nexora, {
        action: input.role !== undefined ? 'ROLE_ASSIGNED' : 'USER_UPDATED',
        resourceType: 'User',
        resourceId: user.id,
        actor: request.principal,
        beforeState: before,
        afterState: { role: updated.role.name, status: updated.status, displayName: updated.displayName },
        correlationId: request.id,
        ipAddress: request.ip,
      });
      return await reply.status(200).send({ id: updated.id, role: updated.role.name, status: updated.status });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/users/:id/revoke-sessions',
    { preHandler: [app.requirePermission('user.write')] },
    async (request, reply) => {
      const user = await nexora.prisma.user.findUnique({ where: { id: request.params.id } });
      if (user === null) throw new NotFoundError('User', request.params.id, request.id);
      const result = await nexora.prisma.userSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await writeAudit(nexora, {
        action: 'SESSIONS_REVOKED',
        resourceType: 'User',
        resourceId: user.id,
        actor: request.principal,
        afterState: { revokedCount: result.count },
        correlationId: request.id,
        ipAddress: request.ip,
      });
      return await reply.status(200).send({ revoked: result.count });
    },
  );
}
