/**
 * Shared company (tenant) provisioning (§91).
 *
 * Creates a Tenant, its first SUPER_ADMIN user, and a ready-to-sell starter
 * catalogue cloned from the reference `default` tenant. Used by BOTH public
 * self-signup (`POST /api/v1/tenants/signup`) and owner-initiated onboarding
 * (`POST /api/v1/platform/tenants`), so the two paths stay identical.
 */

import { ConflictError, ValidationError } from '@nexora/domain';
import type { NexoraContext } from '../context.js';
import { writeAudit, type AuthenticatedPrincipal } from '../plugins/auth.js';
import { createOutboxEvent } from '../outbox.js';

export interface ProvisionCompanyInput {
  companyName: string;
  slug?: string;
  adminEmail: string;
  adminPassword: string;
  adminName: string;
  contactPhone?: string;
  country?: string;
}

export interface ProvisionCompanyResult {
  tenant: { id: string; slug: string; name: string; status: string };
  user: { id: string; email: string; displayName: string | null };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export async function provisionCompany(
  nexora: NexoraContext,
  input: ProvisionCompanyInput,
  ctx: { actor: AuthenticatedPrincipal | null; correlationId: string; ipAddress: string },
): Promise<ProvisionCompanyResult> {
  // Resolve a unique slug.
  const base = input.slug ?? slugify(input.companyName);
  if (base.length < 2) throw new ValidationError('Could not derive a valid company slug.', undefined, ctx.correlationId);
  let slug = base;
  for (let n = 1; (await nexora.prisma.tenant.findUnique({ where: { slug } })) !== null; n += 1) {
    slug = `${base}-${n}`;
  }

  const emailTaken = await nexora.prisma.user.findUnique({ where: { email: input.adminEmail } });
  if (emailTaken !== null) {
    throw new ConflictError('That admin email is already registered.', undefined, ctx.correlationId);
  }

  const superRole = await nexora.prisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } });
  const passwordHash = await nexora.hasher.hash(input.adminPassword);

  const { tenant, user } = await nexora.prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        slug,
        name: input.companyName,
        status: 'TRIAL',
        contactEmail: input.adminEmail,
        ...(input.contactPhone !== undefined ? { contactPhone: input.contactPhone } : {}),
        ...(input.country !== undefined ? { country: input.country.toUpperCase() } : {}),
      },
    });
    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: input.adminEmail,
        passwordHash,
        displayName: input.adminName,
        roleId: superRole.id,
      },
    });

    // Clone the reference catalogue so the company can sell immediately.
    const starters = await tx.package.findMany({
      where: { tenantId: 'default', status: 'ACTIVE' },
      include: { policy: true },
      orderBy: { displayOrder: 'asc' },
    });
    for (const pkg of starters) {
      const cloned = await tx.package.create({
        data: {
          tenantId: tenant.id,
          name: pkg.name,
          description: pkg.description,
          currency: pkg.currency,
          priceMinor: pkg.priceMinor,
          durationSeconds: pkg.durationSeconds,
          status: 'ACTIVE',
          maxDevices: pkg.maxDevices,
          displayOrder: pkg.displayOrder,
        },
      });
      if (pkg.policy !== null) {
        await tx.packagePolicy.create({
          data: {
            packageId: cloned.id,
            downloadKbps: pkg.policy.downloadKbps,
            uploadKbps: pkg.policy.uploadKbps,
            burstDownloadKbps: pkg.policy.burstDownloadKbps,
            burstUploadKbps: pkg.policy.burstUploadKbps,
            fupLimitBytes: pkg.policy.fupLimitBytes,
            fupWarningPercent: pkg.policy.fupWarningPercent,
            fupThrottleDownloadKbps: pkg.policy.fupThrottleDownloadKbps,
            fupThrottleUploadKbps: pkg.policy.fupThrottleUploadKbps,
            fupResetPolicy: pkg.policy.fupResetPolicy,
            sessionTimeLimitSeconds: pkg.policy.sessionTimeLimitSeconds,
          },
        });
      }
    }
    return { tenant, user };
  });

  await createOutboxEvent(nexora, {
    eventType: 'TENANT_CREATED',
    aggregateType: 'Tenant',
    aggregateId: tenant.id,
    payload: { tenantId: tenant.id, slug: tenant.slug, name: tenant.name },
    correlationId: ctx.correlationId,
  });
  await writeAudit(nexora, {
    action: 'TENANT_CREATED',
    resourceType: 'Tenant',
    resourceId: tenant.id,
    actor: ctx.actor,
    afterState: { slug: tenant.slug, name: tenant.name, admin: user.email },
    correlationId: ctx.correlationId,
    ipAddress: ctx.ipAddress,
  });

  return {
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status },
    user: { id: user.id, email: user.email, displayName: user.displayName },
  };
}
