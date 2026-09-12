/**
 * Company (tenant) lifecycle & self-service (§91):
 *
 *  - POST /api/v1/tenants/signup     — public company self-registration. Creates
 *    the Tenant, its first SUPER_ADMIN, and a ready-to-sell starter catalogue
 *    (cloned from the reference `default` tenant). Returns a staff token.
 *  - GET  /api/v1/admin/tenant       — the caller's own company settings +
 *    M-Pesa configuration status (presence booleans only, never secrets).
 *  - PUT  /api/v1/admin/tenant/payment-config — set the company's paybill/till
 *    and Daraja credentials (encrypted at rest, ADR-013).
 *  - PATCH /api/v1/admin/tenant      — branding / contact details.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '@nexora/domain';
import { encryptSecret } from '@nexora/auth';
import { normalizeKenyanMsisdn } from '@nexora/payment-sdk';
import type { NexoraContext } from '../context.js';
import { writeAudit } from '../plugins/auth.js';
import { createOutboxEvent } from '../outbox.js';

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, body: unknown, requestId: string): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Request validation failed.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, requestId);
  }
  return parsed.data;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const signupSchema = z.object({
  companyName: z.string().min(2).max(120),
  slug: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/).optional(),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(10, 'Admin password must be at least 10 characters'),
  adminName: z.string().min(1).max(100),
  contactPhone: z.string().max(32).optional(),
  country: z.string().length(2).optional(),
});

const paymentConfigSchema = z.object({
  channel: z.enum(['PAYBILL', 'TILL']),
  env: z.enum(['sandbox', 'production']).default('sandbox'),
  shortcode: z.string().min(3).max(12),
  partyB: z.string().min(3).max(12).optional(),
  consumerKey: z.string().min(1).optional(),
  consumerSecret: z.string().min(1).optional(),
  passkey: z.string().min(1).optional(),
  callbackUrl: z.string().url().optional(),
});

const tenantUpdateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  contactPhone: z.string().max(32).optional(),
  supportPhone: z.string().max(32).optional(),
  supportEmail: z.string().email().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export async function registerTenantRoutes(app: FastifyInstance, nexora: NexoraContext): Promise<void> {
  // ---- Public self-signup -------------------------------------------------
  app.post<{ Body: unknown }>(
    '/api/v1/tenants/signup',
    { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } },
    async (request, reply) => {
      if (!nexora.env.ALLOW_TENANT_SIGNUP) {
        return await reply.status(403).send({
          error: { code: 'SIGNUP_DISABLED', message: 'Company self-signup is disabled on this deployment.', correlationId: request.id, retryable: false },
        });
      }
      const input = parseOrThrow(signupSchema, request.body, request.id);

      // Resolve a unique slug.
      const base = input.slug ?? slugify(input.companyName);
      if (base.length < 2) throw new ValidationError('Could not derive a valid company slug.', undefined, request.id);
      let slug = base;
      for (let n = 1; (await nexora.prisma.tenant.findUnique({ where: { slug } })) !== null; n += 1) {
        slug = `${base}-${n}`;
      }

      const emailTaken = await nexora.prisma.user.findUnique({ where: { email: input.adminEmail } });
      if (emailTaken !== null) {
        throw new ConflictError('That admin email is already registered.', undefined, request.id);
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
        correlationId: request.id,
      });
      await writeAudit(nexora, {
        action: 'TENANT_CREATED',
        resourceType: 'Tenant',
        resourceId: tenant.id,
        actor: null,
        afterState: { slug: tenant.slug, name: tenant.name, admin: user.email },
        correlationId: request.id,
        ipAddress: request.ip,
      });

      const issued = await nexora.tokens.issue(
        { subjectType: 'user', subjectId: user.id, role: 'SUPER_ADMIN', tenantId: tenant.id },
        { ip: request.ip, userAgent: request.headers['user-agent'] },
      );

      return await reply.status(201).send({
        token: issued.token,
        expiresAt: issued.expiresAt.toISOString(),
        tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status },
        user: { id: user.id, email: user.email, displayName: user.displayName, role: 'SUPER_ADMIN' },
      });
    },
  );

  // ---- Own-company settings ----------------------------------------------
  app.get(
    '/api/v1/admin/tenant',
    { preHandler: [app.requirePermission('tenant.read')] },
    async (request, reply) => {
      const tenant = await nexora.prisma.tenant.findUnique({ where: { id: request.principal!.tenantId } });
      if (tenant === null) {
        return await reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Tenant not found.', correlationId: request.id, retryable: false },
        });
      }
      return await reply.status(200).send({
        tenant: {
          id: tenant.id,
          slug: tenant.slug,
          name: tenant.name,
          status: tenant.status,
          contactEmail: tenant.contactEmail,
          contactPhone: tenant.contactPhone,
          country: tenant.country,
          currency: tenant.currency,
          supportPhone: tenant.supportPhone,
          supportEmail: tenant.supportEmail,
          primaryColor: tenant.primaryColor,
        },
        payment: {
          channel: tenant.mpesaChannel,
          environment: tenant.mpesaEnv,
          shortcode: tenant.mpesaShortcode,
          partyB: tenant.mpesaPartyB,
          callbackUrl: tenant.mpesaCallbackUrl,
          // Presence booleans only — secrets never leave the server.
          credentialsConfigured:
            tenant.mpesaConsumerKeyEnc !== null &&
            tenant.mpesaConsumerSecretEnc !== null &&
            tenant.mpesaPasskeyEnc !== null,
          configuredAt: tenant.mpesaConfiguredAt?.toISOString() ?? null,
          encryptionAvailable: nexora.env.CREDENTIALS_ENCRYPTION_KEY !== undefined,
        },
      });
    },
  );

  app.put<{ Body: unknown }>(
    '/api/v1/admin/tenant/payment-config',
    { preHandler: [app.requirePermission('payment.config.manage')] },
    async (request, reply) => {
      const input = parseOrThrow(paymentConfigSchema, request.body, request.id);
      const key = nexora.env.CREDENTIALS_ENCRYPTION_KEY;
      const wantsCreds = input.consumerKey !== undefined || input.consumerSecret !== undefined || input.passkey !== undefined;
      if (wantsCreds && (key === undefined || key.length === 0)) {
        return await reply.status(409).send({
          error: {
            code: 'ENCRYPTION_UNAVAILABLE',
            message: 'Set CREDENTIALS_ENCRYPTION_KEY on the server before storing M-Pesa credentials.',
            correlationId: request.id,
            retryable: false,
          },
        });
      }

      const tenantId = request.principal!.tenantId;
      const data: Record<string, unknown> = {
        mpesaChannel: input.channel,
        mpesaEnv: input.env,
        mpesaShortcode: input.shortcode,
        mpesaPartyB: input.partyB ?? null,
        ...(input.callbackUrl !== undefined ? { mpesaCallbackUrl: input.callbackUrl } : {}),
      };
      if (wantsCreds && key !== undefined) {
        if (input.consumerKey !== undefined) data.mpesaConsumerKeyEnc = encryptSecret(input.consumerKey, key);
        if (input.consumerSecret !== undefined) data.mpesaConsumerSecretEnc = encryptSecret(input.consumerSecret, key);
        if (input.passkey !== undefined) data.mpesaPasskeyEnc = encryptSecret(input.passkey, key);
        data.mpesaConfiguredAt = new Date();
      }

      await nexora.prisma.tenant.update({ where: { id: tenantId }, data });
      await createOutboxEvent(nexora, {
        eventType: 'TENANT_PAYMENT_CONFIGURED',
        aggregateType: 'Tenant',
        aggregateId: tenantId,
        payload: { tenantId, channel: input.channel, shortcode: input.shortcode },
        correlationId: request.id,
      });
      await writeAudit(nexora, {
        action: 'TENANT_PAYMENT_CONFIGURED',
        resourceType: 'Tenant',
        resourceId: tenantId,
        actor: request.principal,
        afterState: { channel: input.channel, shortcode: input.shortcode, credentialsUpdated: wantsCreds },
        correlationId: request.id,
        ipAddress: request.ip,
      });
      return await reply.status(200).send({ ok: true });
    },
  );

  app.patch<{ Body: unknown }>(
    '/api/v1/admin/tenant',
    { preHandler: [app.requirePermission('tenant.manage')] },
    async (request, reply) => {
      const input = parseOrThrow(tenantUpdateSchema, request.body, request.id);
      await nexora.prisma.tenant.update({
        where: { id: request.principal!.tenantId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.contactPhone !== undefined ? { contactPhone: input.contactPhone } : {}),
          ...(input.supportPhone !== undefined ? { supportPhone: input.supportPhone } : {}),
          ...(input.supportEmail !== undefined ? { supportEmail: input.supportEmail } : {}),
          ...(input.primaryColor !== undefined ? { primaryColor: input.primaryColor } : {}),
        },
      });
      await writeAudit(nexora, {
        action: 'TENANT_UPDATED',
        resourceType: 'Tenant',
        resourceId: request.principal!.tenantId,
        actor: request.principal,
        afterState: input,
        correlationId: request.id,
        ipAddress: request.ip,
      });
      return await reply.status(200).send({ ok: true });
    },
  );

  // ---- Company's own platform subscription & invoices (ISP pays platform) -
  app.get(
    '/api/v1/admin/billing',
    { preHandler: [app.requirePermission('tenant.read')] },
    async (request, reply) => {
      const tenantId = request.principal!.tenantId;
      const tenant = await nexora.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { plan: true } });
      const invoices = await nexora.prisma.platformInvoice.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 24,
        include: { plan: { select: { name: true } } },
      });
      return await reply.status(200).send({
        plan: tenant.plan === null ? null : { code: tenant.plan.code, name: tenant.plan.name, priceMinor: tenant.plan.priceMinor, interval: tenant.plan.interval },
        planStatus: tenant.planStatus,
        trialEndsAt: tenant.trialEndsAt?.toISOString() ?? null,
        currentPeriodEnd: tenant.currentPeriodEnd?.toISOString() ?? null,
        invoices: invoices.map((i) => ({
          id: i.id, number: i.number, plan: i.plan?.name ?? null, amountMinor: i.amountMinor, currency: i.currency,
          status: i.status, dueDate: i.dueDate.toISOString(), periodEnd: i.periodEnd.toISOString(),
          paidAt: i.paidAt?.toISOString() ?? null, receipt: i.receipt,
          // A PENDING/OVERDUE invoice with a live provider txn has a payment in flight.
          paymentInFlight: (i.status === 'PENDING' || i.status === 'OVERDUE') && i.providerTransactionId !== null,
        })),
      });
    },
  );

  // Pay an outstanding platform invoice via STK to the PLATFORM's M-Pesa.
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/admin/billing/invoices/:id/pay',
    { preHandler: [app.requirePermission('payment.config.manage')], config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = parseOrThrow(z.object({ phone: z.string() }), request.body, request.id);
      const phone = normalizeKenyanMsisdn(input.phone);
      if (phone === null) throw new ValidationError('Invalid Kenyan phone number.', undefined, request.id);

      const invoice = await nexora.prisma.platformInvoice.findFirst({
        where: { id: request.params.id, tenantId: request.principal!.tenantId, status: { in: ['PENDING', 'OVERDUE'] } },
      });
      if (invoice === null) throw new NotFoundError('PlatformInvoice', request.params.id, request.id);
      if (invoice.providerTransactionId !== null) {
        return await reply.status(409).send({ error: { code: 'PAYMENT_IN_FLIGHT', message: 'A payment for this invoice is already being processed.', correlationId: request.id, retryable: true } });
      }

      let providerTransactionId: string;
      try {
        const provider = await nexora.paymentsFor('platform');
        const push = await provider.initiateStkPush({
          phoneNumber: phone,
          amountMinor: invoice.amountMinor,
          accountReference: invoice.number.slice(0, 12),
          description: 'NEXORA subscription',
          transactionReference: `${invoice.id}:${Date.now()}`,
        });
        providerTransactionId = push.providerTransactionId;
      } catch {
        return await reply.status(502).send({ error: { code: 'PAYMENT_PROVIDER_ERROR', message: 'Payment provider rejected the request. Ask the platform owner to configure M-Pesa.', correlationId: request.id, retryable: true } });
      }

      await nexora.prisma.platformInvoice.update({
        where: { id: invoice.id },
        data: {
          providerTransactionId,
          phoneNumber: phone,
          failureReason: null,
          metadata: { payAttemptAt: new Date().toISOString() },
        },
      });
      await writeAudit(nexora, { action: 'PLATFORM_INVOICE_PAYMENT_INITIATED', resourceType: 'PlatformInvoice', resourceId: invoice.id, actor: request.principal, correlationId: request.id, ipAddress: request.ip });
      return await reply.status(202).send({ ok: true, status: 'PENDING', message: 'STK push sent. Complete the payment on your phone.' });
    },
  );
}
