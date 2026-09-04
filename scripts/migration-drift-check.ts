/**
 * Migration drift check: apply every shipped migration to a fresh embedded
 * PostgreSQL, then diff the live database against the Prisma schema. Any
 * output = drift = commercial blocker. Exit 0 only when the diff is EMPTY.
 *
 * Run: npx tsx scripts/migration-drift-check.ts
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PG_PORT = 5435;
const DATABASE_URL = `postgresql://nexora:nexora@localhost:${PG_PORT}/nexora`;

async function main(): Promise<void> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dataDir = join(ROOT, '.tmp', 'pg-drift');
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });

  const pg = new (EmbeddedPostgres as new (o: object) => {
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    createDatabase(name: string): Promise<void>;
  })({ databaseDir: dataDir, user: 'nexora', password: 'nexora', port: PG_PORT, persistent: false });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('nexora');

  try {
    execFileSync('npx prisma migrate deploy', {
      cwd: join(ROOT, 'packages', 'db'),
      env: { ...process.env, DATABASE_URL },
      stdio: 'pipe',
      shell: true,
    });
    console.log('[drift-check] migrations applied cleanly');

    let diff = '';
    try {
      diff = execFileSync(
        `npx prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --script`,
        { cwd: join(ROOT, 'packages', 'db'), env: { ...process.env, DATABASE_URL }, stdio: 'pipe', shell: true },
      ).toString();
    } catch (error) {
      // execFileSync throws on non-zero exit; capture stdout from the error
      diff = ((error as { stdout?: Buffer }).stdout ?? Buffer.from('')).toString() + '\nSTDERR:' + ((error as { stderr?: Buffer }).stderr ?? Buffer.from('')).toString();
    }

    const normalized = diff.trim();
    const isEmptyMigration = normalized.length === 0 || /^--\s*This is an empty migration\.?$/m.test(normalized);
    if (isEmptyMigration) {
      console.log('[drift-check] ✅ ZERO DRIFT — schema exactly equals migrations');
    } else {
      console.error('[drift-check] ❌ DRIFT DETECTED:\n' + normalized.slice(0, 4000));
      process.exitCode = 1;
    }
  } finally {
    await pg.stop();
    rmSync(join(ROOT, '.tmp', 'pg-drift'), { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error('[drift-check] crashed:', error);
  process.exit(1);
});
