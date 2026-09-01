/**
 * NEXORA network-worker (Stage 4 core): executes durable NetworkOperations.
 *
 * Loop (§25): atomically claim one due op (QUEUED/RETRYING -> PROCESSING)
 * -> adapter command -> VERIFYING (read-back via reconcileSubscriber)
 * -> SUCCESS | RETRYING (bounded exponential backoff) | PERMANENT_FAILURE.
 * One mutation in flight per worker satisfies per-router serialization for
 * Phase 1 single-router deployments (§88).
 *
 * ROUTER_ADAPTER=mock runs an in-memory router (local dev / E2E);
 * ROUTER_ADAPTER=mikrotik resolves the Router registry row and its password
 * from the env var named by passwordEnvVar (ADR-008).
 */

import { databaseEnvSchema, parseEnv } from '@nexora/config';
import { createLogger, type Logger } from '@nexora/logging';
import { createPrismaClient, disposePrismaClient, type PrismaClient } from '@nexora/db';
import {
  runReconciliationCycle,
  runRouterHealthCheck,
  runUsageSyncCycle,
} from '@nexora/engines';
import {
  MikroTikAdapter,
  MockRouterAdapter,
  type CanonicalSubscriberState,
  type RouterAdapter,
} from '@nexora/router-sdk';

const POLL_INTERVAL_MS = 2_000;
const JOB_POLL_MS = 3_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 5 * 60_000;
const STALE_PROCESSING_MS = 60_000; // crashed-worker orphan reclaim window
const JOB_TYPES = ['usage-sync', 'network-reconciliation', 'router-health'] as const;

interface DesiredStateShape {
  readonly macAddress: string | null;
  readonly authorized: boolean;
  readonly rateLimit: { downloadKbps: number; uploadKbps: number } | null;
  readonly sessionTimeLimitSeconds?: number | null;
}

interface ClaimedOperation {
  readonly id: string;
  readonly routerId: string;
  readonly operationType: string;
  readonly desiredState: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
}

async function resolveAdapter(
  prisma: PrismaClient,
  mode: 'mock' | 'mikrotik',
  mock: MockRouterAdapter | null,
  routerId: string,
): Promise<RouterAdapter> {
  if (mode === 'mock') {
    return mock ?? new MockRouterAdapter();
  }
  const router = await prisma.router.findUniqueOrThrow({ where: { id: routerId } });
  const password = process.env[router.passwordEnvVar];
  if (password === undefined || password.length === 0) {
    throw new Error(`Router secret '${router.passwordEnvVar}' is not set (ADR-008).`);
  }
  return new MikroTikAdapter(
    {
      host: router.host,
      port: router.port,
      username: router.username,
      passwordEnvVar: router.passwordEnvVar,
      timeoutMs: 10_000,
    },
    password,
  );
}

function toCanonical(desired: DesiredStateShape, macAddress: string): CanonicalSubscriberState {
  return {
    macAddress,
    authorized: desired.authorized,
    rateLimit:
      desired.rateLimit === null
        ? null
        : {
            downloadKbps: desired.rateLimit.downloadKbps,
            uploadKbps: desired.rateLimit.uploadKbps,
            burstDownloadKbps: null,
            burstUploadKbps: null,
          },
    sessionTimeLimitSeconds: desired.sessionTimeLimitSeconds ?? null,
  };
}

async function executeOperation(
  prisma: PrismaClient,
  logger: Logger,
  mode: 'mock' | 'mikrotik',
  mockRouter: MockRouterAdapter | null,
  op: ClaimedOperation,
): Promise<void> {
  try {
    const desired = op.desiredState as DesiredStateShape | null;
    if (desired?.macAddress == null) {
      throw new Error('Operation has no bound device MAC — bind the customer device first (Stage 5 session engine).');
    }

    const adapter = await resolveAdapter(prisma, mode, mockRouter, op.routerId);
    await adapter.connect();
    const canonical = toCanonical(desired, desired.macAddress);

    switch (op.operationType) {
      case 'AUTHORIZE':
      case 'APPLY_POLICY':
      case 'RECONCILE_SYNC':
        await adapter.authorizeSubscriber(canonical);
        break;
      case 'DEAUTHORIZE':
      case 'REMOVE_POLICY':
        await adapter.deauthorizeSubscriber(desired.macAddress);
        break;
      case 'DISCONNECT_SESSION':
        await adapter.disconnectSession(desired.macAddress);
        break;
      default:
        throw new Error(`Unknown operation type '${op.operationType}'`);
    }

    // Read-back verification (§25) — the differentiator vs fire-and-forget.
    // Verification semantics depend on the operation: presence+match for
    // authorizations; ABSENCE (or unauthorized) for deauthorizations.
    if (op.operationType !== 'DISCONNECT_SESSION') {
      await prisma.networkOperation.update({ where: { id: op.id }, data: { status: 'VERIFYING' } });
      const report = await adapter.reconcileSubscriber(canonical);
      const verified =
        op.operationType === 'DEAUTHORIZE' || op.operationType === 'REMOVE_POLICY'
          ? report.subscriberState === null || report.subscriberState.authorized === false
          : report.matchesDesired === true;
      if (!verified) {
        throw new Error(
          `Read-back mismatch: matchesDesired=${String(report.matchesDesired)} subscriberPresent=${String(report.subscriberState !== null)}`,
        );
      }
      await prisma.networkOperation.update({
        where: { id: op.id },
        data: {
          status: 'SUCCESS',
          completedAt: new Date(),
          verificationResult: { verified: true, matchesDesired: report.matchesDesired },
        },
      });
    } else {
      await prisma.networkOperation.update({
        where: { id: op.id },
        data: {
          status: 'SUCCESS',
          completedAt: new Date(),
          verificationResult: { verified: true, note: 'DISCONNECT has no read-back contract' },
        },
      });
    }
    logger.info('Network operation SUCCESS', { opId: op.id, type: op.operationType });
  } catch (error) {
    const attempts = op.attempts + 1;
    const exhausted = attempts >= op.maxAttempts;
    const message = (error as Error).message.slice(0, 500);

    if (exhausted) {
      await prisma.networkOperation.update({
        where: { id: op.id },
        data: { status: 'PERMANENT_FAILURE', lastError: message, completedAt: new Date() },
      });
      await prisma.outboxEvent.create({
        data: {
          eventType: 'NETWORK_PROVISION_FAILED',
          aggregateType: 'NetworkOperation',
          aggregateId: op.id,
          payload: { operationId: op.id, reason: message },
          correlationId: `op-${op.id}`,
        },
      });
      logger.error('Network operation PERMANENT_FAILURE', { opId: op.id, attempts, error: message });
    } else {
      const backoff = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_CAP_MS);
      await prisma.networkOperation.update({
        where: { id: op.id },
        data: { status: 'RETRYING', lastError: message, nextAttemptAt: new Date(Date.now() + backoff) },
      });
      logger.warn('Network operation RETRYING', { opId: op.id, attempts, backoffMs: backoff, error: message });
    }
  }
}

async function main(): Promise<void> {
  const env = parseEnv(databaseEnvSchema);
  const logger = createLogger({ service: 'network-worker', level: env.LOG_LEVEL });
  const prisma = createPrismaClient();
  const mode: 'mock' | 'mikrotik' = process.env.ROUTER_ADAPTER === 'mikrotik' ? 'mikrotik' : 'mock';
  const mockRouter = mode === 'mock' ? new MockRouterAdapter() : null;

  await prisma.$queryRaw`SELECT 1`;
  logger.info('Network worker started — operation executor active', {
    env: env.APP_ENV,
    adapter: mode,
  });

  let running = true;

  async function claimJob(): Promise<{ id: string; type: string } | null> {
    const job = await prisma.job.findFirst({
      where: { type: { in: [...JOB_TYPES] }, status: 'QUEUED', runAfter: { lte: new Date() } },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    if (job === null) return null;
    const claimed = await prisma.job.updateMany({
      where: { id: job.id, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 }, workerId: 'network-worker' },
    });
    return claimed.count === 1 ? { id: job.id, type: job.type } : null;
  }

  async function executeJob(job: { id: string; type: string }): Promise<void> {
    let result: string;
    try {
      const router = await prisma.router.findFirst({ orderBy: { createdAt: 'asc' } });
      if (router === null) {
        result = 'no-routers-registered';
      } else {
        const adapter = await resolveAdapter(prisma, mode, mockRouter, router.id);
        switch (job.type) {
          case 'usage-sync': {
            const summary = await runUsageSyncCycle(prisma, router.id, adapter);
            result = `seen=${summary.sessionsSeen} created=${summary.sessionsCreated} ended=${summary.sessionsEnded} bytes=${summary.bytesAccounted.toString()}`;
            break;
          }
          case 'network-reconciliation': {
            const summary = await runReconciliationCycle(prisma, router.id, adapter);
            result = `checked=${summary.checked} drifted=${summary.drifted} repaired=${summary.repaired}`;
            break;
          }
          case 'router-health': {
            const summary = await runRouterHealthCheck(prisma, router.id, adapter);
            result = `status=${summary.status} changed=${summary.statusChanged}`;
            break;
          }
          default:
            throw new Error(`network-worker cannot execute job type '${job.type}'`);
        }
      }
      await prisma.job.update({
        where: { id: job.id },
        data: { status: 'SUCCESS', completedAt: new Date(), result },
      });
      logger.info('Job SUCCESS', { jobId: job.id, type: job.type, result });
    } catch (error) {
      const row = await prisma.job.findUnique({ where: { id: job.id } });
      const attempts = row?.attempts ?? 1;
      const exhausted = attempts >= (row?.maxAttempts ?? 3);
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: exhausted ? 'FAILED' : 'RETRYING',
          lastError: (error as Error).message.slice(0, 500),
          ...(exhausted ? {} : { runAfter: new Date(Date.now() + 2 ** attempts * 1000) }),
        },
      });
      logger.error('Job FAILED', { jobId: job.id, type: job.type, error: (error as Error).message, exhausted });
    }
  }

  const jobLoop = setInterval(() => {
    if (!running) return;
    void claimJob()
      .then((job) => (job === null ? undefined : executeJob(job)))
      .catch((error: unknown) => {
        logger.error('Job runner cycle failed', { error: (error as Error).message });
      });
  }, JOB_POLL_MS);

  async function claimAndExecuteOperation(): Promise<void> {
    // Orphan recovery (§77: worker crash leaves jobs recoverable): a
    // PROCESSING op whose worker died is re-queued after the stale window.
    await prisma.networkOperation.updateMany({
      where: { status: 'PROCESSING', startedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
      data: { status: 'QUEUED', lastError: 'RECOVERED_ORPHANED_PROCESSING' },
    });

    const op = await prisma.networkOperation.findFirst({
      where: { status: { in: ['QUEUED', 'RETRYING'] }, nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
    });
    if (op === null) return;

    // Atomic claim — guards against a competing worker or admin retry racing us.
    const claimed = await prisma.networkOperation.updateMany({
      where: { id: op.id, status: op.status },
      data: { status: 'PROCESSING', startedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return;

    await executeOperation(prisma, logger, mode, mockRouter, {
      id: op.id,
      routerId: op.routerId,
      operationType: op.operationType,
      desiredState: op.desiredState,
      attempts: op.attempts + 1,
      maxAttempts: op.maxAttempts,
    });
  }

  const operationLoop = setInterval(() => {
    if (!running) return;
    void claimAndExecuteOperation().catch((error: unknown) => {
      logger.error('Executor cycle failed', { error: (error as Error).message });
    });
  }, POLL_INTERVAL_MS);

  const shutdown = async (signal: string): Promise<void> => {
    running = false;
    clearInterval(operationLoop);
    clearInterval(jobLoop);
    logger.info('Shutting down', { signal });
    await disposePrismaClient();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((error: unknown) => {
  console.error('Fatal network-worker boot error:', error);
  process.exit(1);
});
