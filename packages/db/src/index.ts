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
