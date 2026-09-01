/**
 * Application context — the composition root wiring ports to implementations.
 * Fastify decorates `app.nexora` with this object.
 */

import type { PrismaClient } from '@prisma/client';
import type { ApiEnv } from '@nexora/config';
import type { Logger } from '@nexora/logging';
import type { PasswordHasher, TokenService } from '@nexora/auth';
import type { PaymentProvider } from '@nexora/payment-sdk';
import type { RouterAdapter } from '@nexora/router-sdk';
import type { ApiMetrics } from './metrics.js';

export interface NexoraContext {
  readonly env: ApiEnv;
  readonly logger: Logger;
  readonly prisma: PrismaClient;
  readonly hasher: PasswordHasher;
  readonly tokens: TokenService;
  readonly payments: PaymentProvider;
  readonly metrics: ApiMetrics;
  /** Router adapter factory — network ops run in network-worker, but the API
   * exposes admin health/sync triggers that need an adapter too. */
  readonly routers: { get(routerId: string): Promise<RouterAdapter> };
}
