/**
 * Environment variable parsing.
 *
 * Infrastructure configuration lives in Railway variables; parsing is strict
 * and fails fast at boot with a report of every invalid key. Business
 * configuration (prices, FUP thresholds) lives in the database — see
 * architecture map §96.
 */

import { z } from 'zod';

export const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
export const nodeEnvSchema = z.enum(['development', 'test', 'production']);

/**
 * A forgiving public-URL field. Platform hosts (Railway, etc.) often expose a
 * service's domain as a BARE hostname (`my-api.up.railway.app`) with no scheme,
 * and an unresolved reference can arrive as an empty string. Rather than crash
 * the whole service on boot, normalize: empty -> undefined (the field is
 * optional), bare host -> `https://host`, strip a trailing slash, and only then
 * reject something that still isn't a URL (e.g. an unfilled `<placeholder>`).
 */
function optionalPublicUrl(): z.ZodType<string | undefined, z.ZodTypeDef, unknown> {
  return z.preprocess((raw) => {
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (trimmed === '') return undefined;
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }, z.string().url().optional());
}

export const baseEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  APP_ENV: z.string().default('local'),
  LOG_LEVEL: logLevelSchema.default('info'),
});

export const databaseEnvSchema = baseEnvSchema.extend({
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection URL'),
});

export const redisEnvSchema = baseEnvSchema.extend({
  REDIS_URL: z.string().url('REDIS_URL must be a valid Redis connection URL'),
});

export const apiEnvSchema = databaseEnvSchema.merge(redisEnvSchema).extend({
  PORT: z.coerce.number().int().positive().default(5000),
  HOST: z.string().default('0.0.0.0'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  /** mock = deterministic in-process provider (local/dev); mpesa = Daraja. */
  PAYMENT_PROVIDER: z.enum(['mock', 'mpesa']).default('mock'),
  /** When the mock provider is active, auto-confirm purchases after N ms so
   *  the full flow completes without a phone. DEFAULT 0 = disabled — this is
   *  a dev convenience only; a production system must NEVER auto-confirm
   *  uncommitted payments (free-service hazard). dev:stack sets 3000. */
  MOCK_PAYMENT_AUTO_CONFIRM_MS: z.coerce.number().int().min(0).default(0),
  /** mock = in-memory router (local/dev); mikrotik = RouterOS API. */
  ROUTER_ADAPTER: z.enum(['mock', 'mikrotik']).default('mock'),
  CORS_ORIGIN: z.string().default('*'),
  /** Public origin of the API (used to build per-tenant M-Pesa callback URLs
   *  and the default webhook URL). e.g. https://api.nexora.co.ke — a bare host
   *  is accepted and normalized to https://, and an empty value is ignored. */
  PUBLIC_BASE_URL: optionalPublicUrl(),
  /** AES-256-GCM master key for tenant-supplied credentials at rest (ADR-013).
   *  Required for any tenant to self-configure M-Pesa; optional otherwise. */
  CREDENTIALS_ENCRYPTION_KEY: z.string().min(32).optional(),
  /** Allow public company self-signup. OFF by default — opt in explicitly with
   *  ALLOW_TENANT_SIGNUP=true once you're ready to accept new companies
   *  (autopsy F7). Keeps an unconfigured deployment from being spammed. */
  ALLOW_TENANT_SIGNUP: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),
});

/**
 * M-Pesa provider configuration. Required by the payments module (Stage 3),
 * deliberately NOT part of apiEnvSchema — the API must boot before payment
 * credentials exist (see RAILWAY_SETUP.md).
 */
export const mpesaEnvSchema = z.object({
  MPESA_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  MPESA_CONSUMER_KEY: z.string().min(1),
  MPESA_CONSUMER_SECRET: z.string().min(1),
  MPESA_SHORTCODE: z.string().min(1),
  MPESA_PASSKEY: z.string().min(1),
  MPESA_CALLBACK_URL: z.string().url(),
  /** Platform-default collection channel (per-tenant config overrides this). */
  MPESA_CHANNEL: z.enum(['paybill', 'till']).default('paybill'),
  /** Till/store number for Buy Goods (defaults to MPESA_SHORTCODE). */
  MPESA_PARTY_B: z.string().optional(),
});

export type MpesaEnv = z.infer<typeof mpesaEnvSchema>;

export type BaseEnv = z.infer<typeof baseEnvSchema>;
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;
export type RedisEnv = z.infer<typeof redisEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;

export interface EnvParseError {
  readonly key: string;
  readonly message: string;
}

/** Platform-specific remediation hints surfaced in boot errors. */
const REMEDIATION_HINTS: Record<string, string> = {
  DATABASE_URL:
    'Create a PostgreSQL service in the Railway project, then set DATABASE_URL = ${{Postgres.DATABASE_URL}} on THIS service.',
  REDIS_URL:
    'Create a Redis service in the Railway project, then set REDIS_URL = ${{Redis.REDIS_URL}} on THIS service.',
  SESSION_SECRET: 'Set SESSION_SECRET to a random string of at least 32 characters (e.g. `openssl rand -hex 32`).',
};

export class EnvValidationError extends Error {
  public readonly issues: readonly EnvParseError[];

  constructor(issues: readonly EnvParseError[]) {
    const remediation = issues
      .map((issue) => REMEDIATION_HINTS[issue.key])
      .filter((hint): hint is string => hint !== undefined);
    const uniqueHints = [...new Set(remediation)];
    super(
      `Invalid environment configuration:\n${issues.map((i) => `  - ${i.key}: ${i.message}`).join('\n')}` +
        (uniqueHints.length > 0 ? `\nRemediation:\n${uniqueHints.map((h) => `  > ${h}`).join('\n')}` : '') +
        `\nSee RAILWAY_SETUP.md for the full deployment runbook.`,
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export function parseEnv<S extends z.ZodTypeAny>(
  schema: S,
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues: EnvParseError[] = result.error.issues.map((issue) => ({
      key: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
    throw new EnvValidationError(issues);
  }
  return result.data;
}
