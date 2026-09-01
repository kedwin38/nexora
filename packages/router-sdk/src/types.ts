/**
 * Canonical router types.
 *
 * Desired network state is expressed in vendor-neutral form (architecture map
 * §20/§26). Adapters translate canonical state into vendor-specific commands
 * and normalize vendor responses back into canonical readback state.
 */

import { ExternalSystemError } from '@nexora/domain';
import type { RouterCapability } from './capabilities.js';

/** Rate limits in kbps; 0/null means unrestricted. Times in seconds. */
export interface CanonicalRateLimit {
  readonly downloadKbps: number | null;
  readonly uploadKbps: number | null;
  readonly burstDownloadKbps?: number | null;
  readonly burstUploadKbps?: number | null;
}

/** The complete desired (or observed) network state of one subscriber device. */
export interface CanonicalSubscriberState {
  readonly macAddress: string;
  readonly authorized: boolean;
  readonly rateLimit: CanonicalRateLimit | null;
  readonly sessionTimeLimitSeconds: number | null;
}

export interface RouterHealthReport {
  readonly online: boolean;
  readonly cpuPercent: number | null;
  readonly memoryPercent: number | null;
  readonly uptimeSeconds: number | null;
  readonly version: string | null;
  readonly boardName: string | null;
  readonly raw?: Record<string, unknown>;
}

export interface RouterActiveSession {
  readonly macAddress: string;
  readonly ipAddress: string | null;
  readonly uptimeSeconds: number | null;
  readonly downloadBytes: number | null;
  readonly uploadBytes: number | null;
}

export interface RouterUsageReport {
  readonly macAddress: string;
  readonly downloadBytes: number | null;
  readonly uploadBytes: number | null;
  /** Monotonic counter semantics: true when the adapter could not guarantee monotonicity. */
  readonly counterResetSuspected: boolean;
}

export class CapabilityNotSupportedError extends ExternalSystemError {
  constructor(adapter: string, capability: RouterCapability) {
    super(adapter, `Router adapter '${adapter}' does not support ${capability}.`, {
      retryable: false,
      details: { adapter, capability },
    });
  }
}

export interface ReconciliationReport {
  readonly subscriberState: CanonicalSubscriberState | null;
  readonly matchesDesired: boolean | null; // null when the subscriber was not found
}
