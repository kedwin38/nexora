/**
 * Local development stack — one command, zero external dependencies.
 *
 * Boots embedded PostgreSQL (persistent data dir — your local data survives
 * restarts), applies migrations + seed, then runs api(:5000) + worker +
 * network-worker + scheduler with the MOCK payment provider (auto-confirm
 * after 3s) and MOCK router adapter. Ctrl+C tears everything down cleanly.
 *
 * Run: npm run dev:stack
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PG_PORT = 5432;
const API_PORT = 5000;
const DATABASE_URL = `postgresql://nexora:nexora@localhost:${PG_PORT}/nexora`;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@nexora.isp';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin!2026';

async function main(): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    DATABASE_URL,
    REDIS_URL: 'redis://localhost:6379', // presence-only at this stage
    SESSION_SECRET: process.env.SESSION_SECRET ?? 'local-dev-secret-change-me-0123456789',
    SESSION_TTL_HOURS: '24',
    PAYMENT_PROVIDER: 'mock',
    MOCK_PAYMENT_AUTO_CONFIRM_MS: '3000',
    ROUTER_ADAPTER: 'mock',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
    PORT: String(API_PORT),
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
  };

  console.log('[dev-stack] starting embedded PostgreSQL…');
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dataDir = join(ROOT, '.tmp', 'pg-dev');
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });
  const pg = new (EmbeddedPostgres as new (o: object) => {
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    createDatabase(name: string): Promise<void>;
  })({ databaseDir: dataDir, user: 'nexora', password: 'nexora', port: PG_PORT, persistent: true });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('nexora').catch(() => undefined); // already exists on restart
  console.log('[dev-stack] PostgreSQL up (persistent:', dataDir, ')');

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
  console.log('[dev-stack] migrations + seed applied');

  const services: Array<{ name: string; child: ReturnType<typeof spawn> }> = [];
  const start = (name: string, cwd: string, extra: Record<string, string> = {}): void => {
    const child = spawn(process.execPath, ['dist/index.cjs'], {
      cwd,
      env: { ...env, ...extra },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    services.push({ name, child });
  };

  start('api', join(ROOT, 'apps', 'api'));
  start('worker', join(ROOT, 'apps', 'worker'));
  start('network-worker', join(ROOT, 'apps', 'network-worker'));
  start('scheduler', join(ROOT, 'apps', 'scheduler'), { SCHEDULER_TICK_SECONDS: '30' });

  await sleep(2_500);
  console.log('');
  console.log('  ┌──────────────────────────────────────────────────────────┐');
  console.log('  │  NEXORA local stack is UP                                │');
  console.log('  │                                                          │');
  console.log(`  │  Portal + API   http://localhost:${API_PORT}                │`);
  console.log('  │  Next.js portal  (optional) npm run dev -w @nexora/web   │');
  console.log('  │                                                          │');
  console.log(`  │  Admin login     ${ADMIN_EMAIL} / ${ADMIN_PASSWORD.padEnd(16).slice(0, 16)}│`);
  console.log('  │  Payments        MOCK provider, auto-confirms in 3s      │');
  console.log('  │  Router          MOCK adapter (in-memory)                │');
  console.log('  │                                                          │');
  console.log('  │  Ctrl+C stops everything (data persists in .tmp/pg-dev)  │');
  console.log('  └──────────────────────────────────────────────────────────┘');
  console.log('');

  const shutdown = (signal: string): void => {
    console.log(`\n[dev-stack] ${signal} — shutting down…`);
    for (const { child } of services) child.kill();
    setTimeout(() => {
      void pg.stop().finally(() => process.exit(0));
    }, 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  services.forEach(({ name, child }) => {
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) console.error(`[dev-stack] ${name} exited with code ${code}`);
    });
  });
  // Keep the process alive.
  await new Promise<void>(() => undefined);
}

void main().catch((error: unknown) => {
  console.error('[dev-stack] fatal:', error);
  process.exit(1);
});
