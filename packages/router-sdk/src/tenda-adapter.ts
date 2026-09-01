/**
 * Tenda adapter skeleton (TD-007, persona step 17).
 *
 * Tenda consumer routers expose no documented management API; Phase 1
 * support is health-ping only (ICMP-style TCP connect probe via fetch-less
 * net.connect). Every control capability raises CapabilityNotSupportedError
 * — explicit failure, never a silent no-op (§23).
 */

import { createConnection } from 'node:net';
import type { RouterAdapter, RouterConnectionConfig } from './adapter.js';
import { capabilitySet } from './capabilities.js';
import {
  CapabilityNotSupportedError,
  type CanonicalSubscriberState,
  type ReconciliationReport,
  type RouterActiveSession,
  type RouterHealthReport,
  type RouterUsageReport,
} from './types.js';

type UnsupportedCapability =
  | 'CAP_AUTH'
  | 'CAP_DEAUTH'
  | 'CAP_RATE_LIMIT'
  | 'CAP_SESSION_CONTROL'
  | 'CAP_USAGE'
  | 'CAP_CLIENT_DISCOVERY'
  | 'CAP_POLICY_READBACK';

export class TendaAdapter implements RouterAdapter {
  public readonly vendor = 'tenda';
  public readonly connection: RouterConnectionConfig;

  constructor(connection: RouterConnectionConfig) {
    this.connection = connection;
  }

  public getCapabilities() {
    return capabilitySet(['CAP_HEALTH']).capabilities;
  }

  public async connect(): Promise<void> {
    // Health model connects on demand; nothing persistent to hold.
  }

  public async close(): Promise<void> {}

  public async healthCheck(): Promise<RouterHealthReport> {
    const reachable = await this.probe();
    return {
      online: reachable,
      cpuPercent: null,
      memoryPercent: null,
      uptimeSeconds: null,
      version: null,
      boardName: null,
    };
  }

  public async authorizeSubscriber(_state: CanonicalSubscriberState): Promise<void> {
    throw this.unsupported('CAP_AUTH');
  }

  public async deauthorizeSubscriber(_macAddress: string): Promise<void> {
    throw this.unsupported('CAP_DEAUTH');
  }

  public async applyPolicy(_state: CanonicalSubscriberState): Promise<void> {
    throw this.unsupported('CAP_RATE_LIMIT');
  }

  public async removePolicy(_macAddress: string): Promise<void> {
    throw this.unsupported('CAP_RATE_LIMIT');
  }

  public async disconnectSession(_macAddress: string): Promise<void> {
    throw this.unsupported('CAP_SESSION_CONTROL');
  }

  public async getActiveSessions(): Promise<RouterActiveSession[]> {
    throw this.unsupported('CAP_CLIENT_DISCOVERY');
  }

  public async getUsage(_macAddress: string): Promise<RouterUsageReport> {
    throw this.unsupported('CAP_USAGE');
  }

  public async reconcileSubscriber(_desired: CanonicalSubscriberState): Promise<ReconciliationReport> {
    throw this.unsupported('CAP_POLICY_READBACK');
  }

  private unsupported(capability: UnsupportedCapability): CapabilityNotSupportedError {
    return new CapabilityNotSupportedError('tenda', capability);
  }

  /** TCP-connect probe against the management port within the timeout. */
  private probe(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: this.connection.host, port: 80 });
      const finish = (ok: boolean): void => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(this.connection.timeoutMs, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
  }
}
