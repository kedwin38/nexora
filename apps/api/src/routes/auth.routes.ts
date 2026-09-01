/**
 * Staff authentication: /api/v1/auth/{login,logout,me}.
 * Customers authenticate via /api/v1/customers/{register,login}.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UnauthorizedError, ValidationError } from '@nexora/domain';
import type { NexoraContext } from '../context.js';
import { writeAudit } from '../plugins/auth.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function registerAuthRoutes(app: FastifyInstance, nexora: NexoraContext): Promise<void> {
  app.post<{ Body: unknown }>('/api/v1/auth/login', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Email and password are required.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      }, request.id);
    }

    const user = await nexora.prisma.user.findUnique({
      where: { email: parsed.data.email },
      include: { role: true },
    });
    const passwordOk =
      user !== null && user.status === 'ACTIVE'
        ? await nexora.hasher.verify(parsed.data.password, user.passwordHash)
        : false;

    // Constant-ish path: even unknown users run a hash comparison.
    if (user === null) {
      await nexora.hasher.verify(parsed.data.password, '$argon2id$v=19$m=19456,t=2,p=1$decoy$decoy');
    }

    if (!passwordOk || user === null) {
      await writeAudit(nexora, {
        action: 'AUTH_LOGIN_FAILED',
        resourceType: 'User',
        resourceId: parsed.data.email,
        actor: null,
        result: 'FAILURE',
        correlationId: request.id,
        ipAddress: request.ip,
      });
      throw new UnauthorizedError('Invalid credentials.', request.id);
    }

    const issued = await nexora.tokens.issue(
      { subjectType: 'user', subjectId: user.id, role: user.role.name },
      { ip: request.ip, userAgent: request.headers['user-agent'] },
    );
    await nexora.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await writeAudit(nexora, {
      action: 'AUTH_LOGIN_SUCCESS',
      resourceType: 'User',
      resourceId: user.id,
      actor: { subjectType: 'user', subjectId: user.id, role: user.role.name, permissions: [] },
      correlationId: request.id,
      ipAddress: request.ip,
    });

    return await reply.status(200).send({
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role.name },
    });
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      await nexora.tokens.revoke(header.slice('Bearer '.length));
    }
    return await reply.status(200).send({ ok: true });
  });

  app.get('/api/v1/auth/me', async (request, reply) => {
    if (request.principal === null || request.principal.subjectType !== 'user') {
      throw new UnauthorizedError(undefined, request.id);
    }
    const user = await nexora.prisma.user.findUnique({
      where: { id: request.principal.subjectId },
      select: { id: true, email: true, displayName: true, role: { select: { name: true } } },
    });
    if (user === null) throw new UnauthorizedError(undefined, request.id);
    return await reply.status(200).send({
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role.name },
      permissions: request.principal.permissions,
    });
  });
}
