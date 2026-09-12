/**
 * Prisma client factory.
 *
 * Exactly one client per process (Prisma holds a connection pool). Apps call
 * createPrismaClient() once at boot and dispose it on shutdown.
 */

import { PrismaClient } from '@prisma/client';

export type { Prisma, PrismaClient } from '@prisma/client';
export * from '@prisma/client';

export interface PrismaClientOptions {
  readonly logQueries?: boolean;
}

let cached: PrismaClient | null = null;

export function createPrismaClient(options: PrismaClientOptions = {}): PrismaClient {
  if (cached !== null) {
    return cached;
  }
  cached = new PrismaClient({
    log: options.logQueries
      ? [{ emit: 'stdout', level: 'query' }, { emit: 'stdout', level: 'warn' }, { emit: 'stdout', level: 'error' }]
      : [{ emit: 'stdout', level: 'warn' }, { emit: 'stdout', level: 'error' }],
  });
  return cached;
}

/**
 * Blocks until the database is not just reachable but MIGRATED — i.e. a core
 * table exists. Only the `api` service runs migrations (single migrator, no
 * concurrent-migrate races); the worker/network-worker/scheduler must WAIT for
 * that to land rather than crash on `P2021: table does not exist` and burn
 * through their restart budget when services deploy in parallel. Retries with
 * capped exponential backoff up to `timeoutMs`, then rethrows the last error.
 */
export async function waitForSchemaReady(
  prisma: PrismaClient,
  options: {
    readonly timeoutMs?: number;
    /** A table that only exists after migrations. Must be a trusted literal. */
    readonly probeTable?: string;
    readonly onWait?: (attempt: number, error: unknown) => void;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const probeTable = options.probeTable ?? 'Job';
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      // Succeeds whether the table is empty or not; throws if it doesn't exist
      // or the DB is unreachable. probeTable is a trusted constant, not input.
      await prisma.$queryRawUnsafe(`SELECT 1 FROM "${probeTable}" LIMIT 1`);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      options.onWait?.(attempt, error);
      const backoffMs = Math.min(1000 * 2 ** Math.min(attempt, 5), 15_000);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

/** For tests only: drops the cached singleton. */
export function resetPrismaClientForTests(): void {
  cached = null;
}

export async function disposePrismaClient(): Promise<void> {
  if (cached !== null) {
    await cached.$disconnect();
    cached = null;
  }
}
