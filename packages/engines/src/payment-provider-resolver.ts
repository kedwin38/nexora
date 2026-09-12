/**
 * Per-tenant M-Pesa provider resolution.
 *
 * Each company (tenant) collects through its own paybill or till with its own
 * Daraja API credentials (stored encrypted, ADR-013). This resolver turns a
 * tenant row into a live PaymentProvider, decrypting credentials with the
 * master key. When a tenant has not configured M-Pesa — or the master key is
 * absent, or decryption fails — it falls back to the platform-default provider
 * (mock in dev, or the env-configured Daraja app), so the system always has a
 * working provider and a payment is never stranded for lack of one.
 */

import type { PrismaClient } from '@prisma/client';
import { decryptSecret } from '@nexora/auth';
import { MpesaDarajaProvider, type PaymentProvider } from '@nexora/payment-sdk';
import type { PaymentProviderResolver } from './payment-reconciliation.js';

export interface TenantProviderResolverOptions {
  /** Provider used when a tenant has no own M-Pesa config. */
  readonly fallback: PaymentProvider;
  /** CREDENTIALS_ENCRYPTION_KEY — required to decrypt tenant credentials. */
  readonly masterKey?: string | undefined;
  /** Global webhook URL used when a tenant stored none. */
  readonly defaultCallbackUrl?: string | undefined;
}

/** Returns true when the tenant row carries a full, usable M-Pesa config. */
export function tenantHasMpesaConfig(tenant: {
  mpesaShortcode: string | null;
  mpesaPasskeyEnc: string | null;
  mpesaConsumerKeyEnc: string | null;
  mpesaConsumerSecretEnc: string | null;
}): boolean {
  return (
    tenant.mpesaShortcode !== null &&
    tenant.mpesaPasskeyEnc !== null &&
    tenant.mpesaConsumerKeyEnc !== null &&
    tenant.mpesaConsumerSecretEnc !== null
  );
}

export function createTenantPaymentResolver(
  prisma: PrismaClient,
  options: TenantProviderResolverOptions,
): PaymentProviderResolver {
  // Reuse a provider instance while a tenant's config is unchanged, so the
  // provider's OAuth token cache survives across payments instead of
  // re-authenticating with Daraja on every request. The cache key folds in
  // the config fingerprint, so a credential/channel change makes a fresh one.
  const cache = new Map<string, PaymentProvider>();

  return async ({ tenantId }): Promise<PaymentProvider | null> => {
    if (options.masterKey === undefined || options.masterKey.length === 0) {
      return options.fallback;
    }
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (tenant === null || !tenantHasMpesaConfig(tenant)) {
      return options.fallback;
    }
    const fingerprint = [
      tenant.id,
      tenant.mpesaConfiguredAt?.getTime() ?? 0,
      tenant.mpesaChannel,
      tenant.mpesaEnv,
      tenant.mpesaShortcode,
      tenant.mpesaPartyB ?? '',
      tenant.mpesaCallbackUrl ?? '',
    ].join('|');
    const cached = cache.get(tenant.id);
    if (cached !== undefined && (cached as { __fingerprint?: string }).__fingerprint === fingerprint) {
      return cached;
    }
    try {
      const provider = new MpesaDarajaProvider({
        env: tenant.mpesaEnv === 'production' ? 'production' : 'sandbox',
        consumerKey: decryptSecret(tenant.mpesaConsumerKeyEnc!, options.masterKey),
        consumerSecret: decryptSecret(tenant.mpesaConsumerSecretEnc!, options.masterKey),
        shortcode: tenant.mpesaShortcode!,
        channel: tenant.mpesaChannel === 'TILL' ? 'till' : 'paybill',
        ...(tenant.mpesaPartyB !== null ? { partyB: tenant.mpesaPartyB } : {}),
        passkey: decryptSecret(tenant.mpesaPasskeyEnc!, options.masterKey),
        callbackUrl: tenant.mpesaCallbackUrl ?? options.defaultCallbackUrl ?? '',
      });
      (provider as { __fingerprint?: string }).__fingerprint = fingerprint;
      cache.set(tenant.id, provider);
      return provider;
    } catch {
      // Corrupt/unreadable credentials — fall back rather than strand payments.
      return options.fallback;
    }
  };
}
