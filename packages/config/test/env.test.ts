import { describe, expect, it } from 'vitest';
import {
  apiEnvSchema,
  baseEnvSchema,
  databaseEnvSchema,
  EnvValidationError,
  parseEnv,
} from '@nexora/config';

const validBase = {
  NODE_ENV: 'test',
  APP_ENV: 'ci',
  LOG_LEVEL: 'info',
} as const;

describe('parseEnv', () => {
  it('parses a valid environment with defaults applied', () => {
    const env = parseEnv(baseEnvSchema, {});
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('accepts a valid database environment', () => {
    const env = parseEnv(databaseEnvSchema, {
      ...validBase,
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/nexora',
    });
    expect(env.DATABASE_URL).toContain('postgresql://');
  });

  it('rejects a missing DATABASE_URL and reports the key', () => {
    try {
      parseEnv(databaseEnvSchema, { ...validBase });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues;
      expect(issues.some((i) => i.key === 'DATABASE_URL')).toBe(true);
    }
  });

  it('boot error includes platform remediation hints', () => {
    try {
      parseEnv(apiEnvSchema, { ...validBase });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as EnvValidationError).message;
      expect(message).toContain('${{Postgres.DATABASE_URL}}');
      expect(message).toContain('${{Redis.REDIS_URL}}');
      expect(message).toContain('openssl rand -hex 32');
      expect(message).toContain('RAILWAY_SETUP.md');
    }
  });

  it('rejects a short SESSION_SECRET', () => {
    const result = apiEnvSchema.safeParse({
      ...validBase,
      DATABASE_URL: 'postgresql://u:p@h:5432/d',
      REDIS_URL: 'redis://localhost:6379',
      SESSION_SECRET: 'too-short',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid log level', () => {
    const result = baseEnvSchema.safeParse({ LOG_LEVEL: 'loud' });
    expect(result.success).toBe(false);
  });
});
