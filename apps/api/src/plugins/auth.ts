/**
 * Authentication + authorization plugin.
 *
 * - `authenticate` hook: Bearer token -> AuthenticatedPrincipal on request.
 * - `requirePermission(p)`: RBAC guard using the static matrix (mirrors seeded DB roles).
 * - `audit(...)`: append-only audit writer (§57).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ForbiddenError,
  UnauthorizedError,
  type CorrelationId,
} from '@nexora/domain';
import {
  permissionsForRole,
  roleHasPermission,
  type Permission,
  type Role,
  TokenError,
} from '@nexora/auth';
import type { NexoraContext } from '../context.js';

export interface AuthenticatedPrincipal {
  readonly subjectType: 'user' | 'customer';
  readonly subjectId: string;
  readonly role: Role;
  readonly permissions: readonly Permission[];
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: AuthenticatedPrincipal | null;
  }
}

export async function registerAuthPlugin(app: FastifyInstance, nexora: NexoraContext): Promise<void> {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    request.principal = null;
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith('Bearer ')) return;
    const token = header.slice('Bearer '.length);
    try {
      const payload = await nexora.tokens.verify(token);
      const role = payload.role as Role;
      request.principal = {
        subjectType: payload.subjectType,
        subjectId: payload.subjectId,
        role,
        permissions: permissionsForRole(role),
      };
    } catch (error) {
      if (error instanceof TokenError) {
        request.authError = error.code;
      }
      // Signature failures leave the request anonymous; guards respond 401.
    }
  });

  app.decorate('requirePermission', (permission: Permission) => {
    return async (request: FastifyRequest, _reply: FastifyReply) => {
      if (request.principal === null) {
        throw new UnauthorizedError(undefined, request.id);
      }
      if (!roleHasPermission(request.principal.role, permission)) {
        throw new ForbiddenError(permission, request.id);
      }
    };
  });

  app.decorate('requireCustomer', async (request: FastifyRequest, _reply: FastifyReply) => {
    if (request.principal === null || request.principal.subjectType !== 'customer') {
      throw new UnauthorizedError('Customer authentication required.', request.id);
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    requirePermission(permission: Permission): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireCustomer(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
  interface FastifyRequest {
    authError?: string;
  }
}

export interface AuditInput {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly actor: AuthenticatedPrincipal | null;
  readonly beforeState?: unknown;
  readonly afterState?: unknown;
  readonly result?: 'SUCCESS' | 'FAILURE';
  readonly correlationId?: CorrelationId;
  readonly ipAddress?: string;
}

/** Append-only audit write. Never throws into the caller's transaction path. */
export async function writeAudit(nexora: NexoraContext, input: AuditInput): Promise<void> {
  await nexora.prisma.auditLog.create({
    data: {
      actorId: input.actor?.subjectType === 'user' ? input.actor.subjectId : null,
      actorType: input.actor === null ? 'SYSTEM' : input.actor.subjectType === 'user' ? 'USER' : 'CUSTOMER',
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ...(input.beforeState !== undefined ? { beforeState: input.beforeState as object } : {}),
      ...(input.afterState !== undefined ? { afterState: input.afterState as object } : {}),
      result: input.result ?? 'SUCCESS',
      ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    },
  });
}
