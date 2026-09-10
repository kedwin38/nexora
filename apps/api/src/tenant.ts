/**
 * Tenant resolution for public (customer/guest) requests.
 *
 * A captive-portal request identifies its company by slug — supplied as the
 * `x-tenant` header, a `?tenant=` query parameter, or a `tenant` body field.
 * Unknown/absent slugs resolve to the reserved `default` tenant so
 * single-tenant deployments and the existing test flows keep working.
 *
 * Staff and customers that are already authenticated carry their tenant in the
 * token principal — those paths use `request.principal.tenantId` directly and
 * never need this helper.
 */

import type { FastifyRequest } from 'fastify';
import { TenantUnavailableError } from '@nexora/domain';
import type { NexoraContext } from './context.js';

export const DEFAULT_TENANT_ID = 'default';

function slugFromRequest(request: FastifyRequest): string | null {
  const header = request.headers['x-tenant'];
  if (typeof header === 'string' && header.trim().length > 0) return header.trim();
  const query = (request.query as Record<string, string | undefined> | undefined)?.tenant;
  if (typeof query === 'string' && query.trim().length > 0) return query.trim();
  const body = request.body as { tenant?: unknown } | undefined;
  if (body !== undefined && typeof body.tenant === 'string' && body.tenant.trim().length > 0) {
    return body.tenant.trim();
  }
  return null;
}

/**
 * Resolves the active tenant id for a public request.
 *
 * - No slug (or the reserved `default` slug) → the `default` tenant.
 * - An unknown slug → the `default` tenant (single-tenant deployments never
 *   send one, so this keeps them working).
 * - A slug that resolves to a SUSPENDED/CLOSED company → refused with a
 *   TenantUnavailableError (403). A suspended company must NOT silently
 *   reroute to `default`, which would leak activity into the wrong tenant
 *   (autopsy F5).
 */
export async function resolveTenantId(nexora: NexoraContext, request: FastifyRequest): Promise<string> {
  const slug = slugFromRequest(request);
  if (slug === null || slug === DEFAULT_TENANT_ID) return DEFAULT_TENANT_ID;
  const tenant = await nexora.prisma.tenant.findUnique({
    where: { slug },
    select: { id: true, status: true },
  });
  if (tenant === null) return DEFAULT_TENANT_ID;
  if (tenant.status === 'SUSPENDED' || tenant.status === 'CLOSED') {
    throw new TenantUnavailableError(undefined, request.id);
  }
  return tenant.id;
}
