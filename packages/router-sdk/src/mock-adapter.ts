/**
 * In-memory MockRouterAdapter.
 *
 * Full RouterAdapter contract implementation used for local development
 * (ROUTER_ADAPTER=mock), adapter contract tests, and chaos testing. Behaves
 * like a real router: state persists, read-back reflects it, unknown
 * subscribers read as absent, counters can be seeded.
 */

import { randomUUID } from 'node:crypto';
import type { RouterAdapter, RouterConnectionConfig } from './adapter.js';
import { capabilitySet, type CapabilitySet } from './capabilities.js';
import type {
  CanonicalSubscriberState,
  ReconciliationReport,
  RouterActiveSession,
  RouterHealthReport,
  RouterUsageReport,
} from './types.js';

export class MockRouterAdapter implements RouterAdapter {
  public readonly vendor = 'mock';
  public readonly connection: RouterConnectionConfig;
  private readonly states = new Map<string, CanonicalSubscriberState>();
  private readonly usage = new Map<string, { download: number; upload: number }>();
  private readonly sessions = new Map<string, { ip: string; uptimeSeconds: number }>();
  public readonly capabilities: CapabilitySet;

  constructor(options?: { capabilities?: ReturnType<typeof capabilitySet> }) {
    this.connection = {
      host: 'mock.local',
      port: 0,
      username: 'mock',
      passwordEnvVar: 'MOCK_ROUTER_PASSWORD',
      timeoutMs: 1000,
    };
    this.capabilities = options?.capabilities ?? capabilitySet([
      'CAP_AUTH',
      'CAP_DEAUTH',
      'CAP_RATE_LIMIT',
      'CAP_SESSION_CONTROL',
      'CAP_USAGE',
      'CAP_HEALTH',
      'CAP_CLIENT_DISCOVERY',
      'CAP_POLICY_READBACK',
    ]);
  }

  public getCapabilities() {
    return this.capabilities.capabilities;
  }

  public async connect(): Promise<void> {}
  public async close(): Promise<void> {}

  public async healthCheck(): Promise<RouterHealthReport> {
    return {
      online: true,
      cpuPercent: 12,
      memoryPercent: 34,
      uptimeSeconds: 86400,
      version: 'mock-7.15',
      boardName: 'MOCK',
    };
  }

  public async authorizeSubscriber(state: CanonicalSubscriberState): Promise<void> {
    this.states.set(state.macAddress, state);
    this.sessions.set(state.macAddress, { ip: `10.5.0.${(this.states.size % 250) + 2}`, uptimeSeconds: 0 });
  }

  public async deauthorizeSubscriber(macAddress: string): Promise<void> {
    this.states.delete(macAddress);
    this.sessions.delete(macAddress);
  }

  public async applyPolicy(state: CanonicalSubscriberState): Promise<void> {
    const existing = this.states.get(state.macAddress);
    this.states.set(state.macAddress, existing === undefined ? state : { ...state });
  }

  public async removePolicy(macAddress: string): Promise<void> {
    const existing = this.states.get(macAddress);
    if (existing !== undefined) {
      this.states.set(macAddress, { ...existing, rateLimit: null });
    }
  }

  public async disconnectSession(macAddress: string): Promise<void> {
    this.sessions.delete(macAddress);
  }

  public async getActiveSessions(): Promise<RouterActiveSession[]> {
    return [...this.sessions.entries()].map(([macAddress, session]) => ({
      macAddress,
      ipAddress: session.ip,
      uptimeSeconds: session.uptimeSeconds,
      downloadBytes: this.usage.get(macAddress)?.download ?? null,
      uploadBytes: this.usage.get(macAddress)?.upload ?? null,
    }));
  }

  public async getUsage(macAddress: string): Promise<RouterUsageReport> {
    const counters = this.usage.get(macAddress);
    return {
      macAddress,
      downloadBytes: counters?.download ?? 0,
      uploadBytes: counters?.upload ?? 0,
      counterResetSuspected: false,
    };
  }

  public async reconcileSubscriber(desired: CanonicalSubscriberState): Promise<ReconciliationReport> {
    const actual = this.states.get(desired.macAddress);
    if (actual === undefined) {
      return { subscriberState: null, matchesDesired: null };
    }
    return { subscriberState: actual, matchesDesired: canonicalEquals(actual, desired) };
  }

  // ---- Test/dev helpers (not part of the RouterAdapter contract) ----

  public seedUsage(macAddress: string, download: number, upload: number): void {
    this.usage.set(macAddress, { download, upload });
  }

  public snapshotState(macAddress: string): CanonicalSubscriberState | undefined {
    return this.states.get(macAddress);
  }

  public newMac(): string {
    const hex = randomUUID().replaceAll('-', '').slice(0, 12);
    return hex.match(/.{2}/g)!.join(':').toUpperCase();
  }
}

export function canonicalEquals(a: CanonicalSubscriberState, b: CanonicalSubscriberState): boolean {
  return (
    a.macAddress === b.macAddress &&
    a.authorized === b.authorized &&
    a.sessionTimeLimitSeconds === b.sessionTimeLimitSeconds &&
    JSON.stringify(a.rateLimit ?? null) === JSON.stringify(b.rateLimit ?? null)
  );
}
