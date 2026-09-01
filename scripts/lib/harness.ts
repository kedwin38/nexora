/**
 * Shared E2E harness: boots an embedded PostgreSQL, applies migrations +
 * seed, starts api + worker + network-worker (mock provider + mock router),
 * and tears everything down. Used by scripts/e2e.ts and scripts/e2e-chaos.ts.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';

const ROOT = resolve(import.meta.dirname, '..', '..');

export const ADMIN_EMAIL = 'admin@nexora.test';
export const ADMIN_PASSWORD = 'E2eAdmin!2026';
const SESSION_SECRET = 'e2e-local-secret-0123456789abcdef0123456789abcdef';

export interface Stack {
  readonly prisma: PrismaClient;
  readonly baseUrl: string;
  readonly env: NodeJS.ProcessEnv;
  stop(): Promise<void>;
}

export async function waitForHttp(url: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return false;
}

export async function startStack(options?: { port?: number; pgPort?: number }): Promise<Stack> {
  const PORT = options?.port ?? 5050;
  const PG_PORT = options?.pgPort ?? 5433;
  const DATABASE_URL = `postgresql://nexora:nexora@localhost:${PG_PORT}/nexora`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_URL,
    REDIS_URL: 'redis://localhost:6379', // presence-only for these services
    SESSION_SECRET,
    SESSION_TTL_HOURS: '24',
    PAYMENT_PROVIDER: 'mock',
    ROUTER_ADAPTER: 'mock',
    LOG_LEVEL: 'warn',
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
  };

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dataDir = join(ROOT, '.tmp', `pg-${PG_PORT}`);
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });

  const pg = new (EmbeddedPostgres as new (o: object) => {
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    createDatabase(name: string): Promise<void>;
  })({
    databaseDir: dataDir,
    user: 'nexora',
    password: 'nexora',
    port: PG_PORT,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('nexora');

  // Migrations + seed (shell:true — npx is npx.cmd on Windows)
  execFileSync('npx prisma migrate deploy', {
    cwd: join(ROOT, 'packages', 'db'),
    env,
    stdio: 'pipe',
    shell: true,
  });
  execFileSync('npx tsx prisma/seed.ts', {
    cwd: join(ROOT, 'packages', 'db'),
    env,
    stdio: 'pipe',
    shell: true,
  });

  const children: Array<() => void> = [];
  const stderrTrail: string[] = [];
  const start = (cwd: string): void => {
    const child = spawn(process.execPath, ['dist/index.cjs'], {
      cwd,
      env: { ...env, PORT: String(PORT) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr!.on('data', (d: Buffer) => {
      stderrTrail.push(...d.toString().split('\n').filter((l) => l.length > 0));
      process.stderr.write(`[svc] ${d}`);
    });
    children.push(() => child.kill());
  };
  start(join(ROOT, 'apps', 'api'));
  start(join(ROOT, 'apps', 'worker'));
  start(join(ROOT, 'apps', 'network-worker'));

  const ready = await waitForHttp(`http://127.0.0.1:${PORT}/health/ready`);
  if (!ready) {
    for (const kill of children) kill();
    await pg.stop();
    throw new Error(
      `Service stack failed to become ready. Last service output:\n${stderrTrail.slice(-30).join('\n')}`,
    );
  }

  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  return {
    prisma,
    baseUrl: `http://127.0.0.1:${PORT}`,
    env,
    async stop() {
      await prisma.$disconnect();
      for (const kill of children) kill();
      await sleep(500);
      await pg.stop();
    },
  };
}

export interface CheckResult {
  failures: number;
}

export function makeChecker(): { check: (name: string, ok: boolean, detail?: string) => void; result: CheckResult } {
  let failures = 0;
  return {
    check(name: string, ok: boolean, detail = ''): void {
      console.log(`${ok ? '  [PASS]' : '  [FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
      if (!ok) failures += 1;
    },
    result: { get failures() { return failures; } },
  };
}

/** Register a customer via the API; returns { token, customerId, phone }. */
export async function registerCustomer(
  baseUrl: string,
  phone: string,
  password = 'Customer!2026',
  displayName?: string,
): Promise<{ token: string; customerId: string; phone: string }> {
  const response = await fetch(`${baseUrl}/api/v1/customers/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password, ...(displayName !== undefined ? { displayName } : {}) }),
  });
  const body = (await response.json()) as { token: string; customer: { id: string } };
  if (!response.ok) throw new Error(`registerCustomer failed: HTTP ${response.status}`);
  return { token: body.token, customerId: body.customer.id, phone };
}

export async function adminLogin(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const body = (await response.json()) as { token: string };
  if (!response.ok) throw new Error('adminLogin failed');
  return body.token;
}

/** Drive the full purchase flow with the mock provider; returns ids. */
export async function purchasePackage(
  baseUrl: string,
  customerToken: string,
  packageId: string,
  macAddress: string,
): Promise<{ paymentId: string; providerTransactionId: string }> {
  const initiate = await fetch(`${baseUrl}/api/v1/payments/initiate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${customerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ packageId, idempotencyKey: crypto.randomUUID(), macAddress }),
  });
  const init = (await initiate.json()) as { paymentId: string; providerTransactionId: string };
  if (initiate.status !== 202) throw new Error(`purchase initiate failed: HTTP ${initiate.status}`);
  return init;
}

export async function sendCallback(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<number> {
  const response = await fetch(`${baseUrl}/api/v1/webhooks/mpesa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await response.json().catch(() => ({}));
  return response.status;
}
