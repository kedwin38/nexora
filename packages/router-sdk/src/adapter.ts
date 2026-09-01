/**
 * RouterAdapter — the vendor-neutral router port (architecture map §22).
 *
 * No domain module may call a router directly. Implementations:
 * MikroTikAdapter (Stage 4), TendaAdapter (skeleton, Stage 4).
 */

import type { RouterCapability } from './capabilities.js';
import type {
  CanonicalSubscriberState,
  ReconciliationReport,
  RouterActiveSession,
  RouterHealthReport,
  RouterUsageReport,
} from './types.js';

export interface RouterConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  /** Name of the Railway variable holding the password — plaintext never enters the DB. */
  readonly passwordEnvVar: string;
  readonly timeoutMs: number;
}

export interface RouterAdapter {
  readonly vendor: string;
  readonly connection: RouterConnectionConfig;

  connect(): Promise<void>;
  close(): Promise<void>;

  healthCheck(): Promise<RouterHealthReport>;
  getCapabilities(): readonly RouterCapability[];

  /** Idempotent: authorizing an already-authorized subscriber must be a no-op success. */
  authorizeSubscriber(state: CanonicalSubscriberState): Promise<void>;
  /** Idempotent: deauthorizing an unknown subscriber must be a no-op success. */
  deauthorizeSubscriber(macAddress: string): Promise<void>;
  /** Desired-state command: applies the full canonical policy. */
  applyPolicy(state: CanonicalSubscriberState): Promise<void>;
  removePolicy(macAddress: string): Promise<void>;

  disconnectSession(macAddress: string): Promise<void>;
  getActiveSessions(): Promise<readonly RouterActiveSession[]>;
  getUsage(macAddress: string): Promise<RouterUsageReport>;
  /** Reads back actual state and compares against the passed desired state. */
  reconcileSubscriber(desired: CanonicalSubscriberState): Promise<ReconciliationReport>;
}
