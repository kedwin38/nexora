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

export class EnvValidationError extends Error {
  public readonly issues: readonly EnvParseError[];

  constructor(issues: readonly EnvParseError[]) {
    super(
      `Invalid environment configuration:\n${issues.map((i) => `  - ${i.key}: ${i.message}`).join('\n')}`,
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
