/**
 * MikroTik RouterOS adapter (Stage 4).
 *
 * Authorization: /ip/hotspot/ip-binding (bypassed) per device MAC — the
 * approach proven in the legacy system — plus /queue/simple rate limits for
 * policy enforcement and print read-backs for verification (§25). Speaks the
 * RouterOS API wire protocol (=key=value parameters) via node-routeros.
 *
 * KR-3: command paths mirror RouterOS 7 syntax and the legacy system's
 * working production calls; the contract is pinned by MockRouterAdapter
 * tests until hardware verification.
 */

import { RouterOSAPI } from 'node-routeros';
import type { RouterAdapter, RouterConnectionConfig } from './adapter.js';
import { capabilitySet } from './capabilities.js';
import type {
  CanonicalSubscriberState,
  ReconciliationReport,
  RouterActiveSession,
  RouterHealthReport,
  RouterUsageReport,
} from './types.js';

type RosRow = Record<string, unknown>;

export class MikroTikAdapter implements RouterAdapter {
  public readonly vendor = 'mikrotik';
  public readonly connection: RouterConnectionConfig;
  private readonly password: string;
  private client: RouterOSAPI | null = null;

  constructor(connection: RouterConnectionConfig, password: string) {
    this.connection = connection;
    this.password = password;
  }

  public getCapabilities() {
    return capabilitySet([
      'CAP_AUTH',
      'CAP_DEAUTH',
      'CAP_RATE_LIMIT',
      'CAP_SESSION_CONTROL',
      'CAP_USAGE',
      'CAP_HEALTH',
      'CAP_POLICY_READBACK',
    ]).capabilities;
  }

  public async connect(): Promise<void> {
    if (this.client !== null) return;
    const client = new RouterOSAPI({
      host: this.connection.host,
      user: this.connection.username,
      password: this.password,
      port: this.connection.port,
      timeout: this.connection.timeoutMs / 1000,
      keepalive: false,
    });
    await client.connect();
    this.client = client;
  }

  public async close(): Promise<void> {
    if (this.client !== null) {
      await this.client.close();
      this.client = null;
    }
  }

  /** write(['/ip/hotspot/ip-binding/add'], 'mac-address', mac, 'type', 'bypassed') */
  private async write(command: string[], ...params: Array<[string, string]>): Promise<RosRow[]> {
    await this.connect();
    if (this.client === null) throw new Error('MikroTik client not connected');
    const flat: string[] = [];
    for (const [key, value] of params) flat.push(`=${key}=${value}`);
    const response = await this.client.write([...command, ...flat]);
    return response as unknown as RosRow[];
  }

  public async healthCheck(): Promise<RouterHealthReport> {
    const rows = await this.write(['/system/resource/print']);
    const resource = rows[0];
    return {
      online: true,
      cpuPercent: numberOrNull(resource?.['cpu-load']),
      memoryPercent: null,
      uptimeSeconds: parseUptime(stringOrNull(resource?.['uptime'])),
      version: stringOrNull(resource?.['version']),
      boardName: stringOrNull(resource?.['board-name']),
    };
  }

  /** Idempotent authorize: replace any existing nexora binding for this MAC. */
  public async authorizeSubscriber(state: CanonicalSubscriberState): Promise<void> {
    await this.deauthorizeSubscriber(state.macAddress);
    await this.write(
      ['/ip/hotspot/ip-binding/add'],
      ['mac-address', state.macAddress],
      ['type', 'bypassed'],
      ['comment', 'nexora:on'],
    );
    await this.syncQueue(state);
  }

  public async deauthorizeSubscriber(macAddress: string): Promise<void> {
    const bindings = await this.write(['/ip/hotspot/ip-binding/print']);
    for (const row of bindings) {
      if (String(row['mac-address'] ?? '').toUpperCase() === macAddress.toUpperCase()) {
        await this.write(['/ip/hotspot/ip-binding/remove'], ['.id', String(row['.id'])]);
      }
    }
    await this.removeQueue(macAddress);
  }

  public async applyPolicy(state: CanonicalSubscriberState): Promise<void> {
    await this.syncQueue(state);
  }

  public async removePolicy(macAddress: string): Promise<void> {
    await this.removeQueue(macAddress);
  }

  public async disconnectSession(macAddress: string): Promise<void> {
    const active = await this.write(['/ip/hotspot/active/print']);
    for (const row of active) {
      if (String(row['mac-address'] ?? '').toUpperCase() === macAddress.toUpperCase()) {
        await this.write(['/ip/hotspot/active/remove'], ['.id', String(row['.id'])]);
      }
    }
  }

  public async getActiveSessions(): Promise<RouterActiveSession[]> {
    const active = await this.write(['/ip/hotspot/active/print']);
    return active.map((row) => ({
      macAddress: String(row['mac-address'] ?? ''),
      ipAddress: stringOrNull(row['address']),
      uptimeSeconds: parseUptime(stringOrNull(row['uptime'])),
      downloadBytes: numberOrNull(row['bytes-in']),
      uploadBytes: numberOrNull(row['bytes-out']),
    }));
  }

  public async getUsage(macAddress: string): Promise<RouterUsageReport> {
    const queues = await this.write(['/queue/simple/print']);
    for (const row of queues) {
      if (String(row['name'] ?? '') === queueName(macAddress)) {
        return {
          macAddress,
          downloadBytes: numberOrNull(row['bytes']),
          uploadBytes: numberOrNull(row['total-bytes']),
          counterResetSuspected: false,
        };
      }
    }
    return { macAddress, downloadBytes: null, uploadBytes: null, counterResetSuspected: false };
  }

  public async reconcileSubscriber(desired: CanonicalSubscriberState): Promise<ReconciliationReport> {
    const bindings = await this.write(['/ip/hotspot/ip-binding/print']);
    const row = bindings.find(
      (b) => String(b['mac-address'] ?? '').toUpperCase() === desired.macAddress.toUpperCase(),
    );
    if (row === undefined) {
      return { subscriberState: null, matchesDesired: null };
    }

    const queues = await this.write(['/queue/simple/print']);
    const queue = queues.find((q) => String(q['name'] ?? '') === queueName(desired.macAddress));
    const maxLimit = stringOrNull(queue?.['max-limit']);

    const actual: CanonicalSubscriberState = {
      macAddress: desired.macAddress,
      authorized: true,
      rateLimit: maxLimit === null ? null : maxLimitToRateLimit(maxLimit),
      sessionTimeLimitSeconds: null,
    };
    const speedsMatch =
      desired.rateLimit === null
        ? actual.rateLimit === null
        : actual.rateLimit !== null &&
          actual.rateLimit.downloadKbps === desired.rateLimit.downloadKbps &&
          actual.rateLimit.uploadKbps === desired.rateLimit.uploadKbps;

    return { subscriberState: actual, matchesDesired: desired.authorized && speedsMatch };
  }

  private async syncQueue(state: CanonicalSubscriberState): Promise<void> {
    await this.removeQueue(state.macAddress);
    if (state.rateLimit === null) return;
    await this.write(
      ['/queue/simple/add'],
      ['name', queueName(state.macAddress)],
      ['target', `${state.macAddress}/32`],
      ['max-limit', `${state.rateLimit.downloadKbps}k/${state.rateLimit.uploadKbps}k`],
      ['comment', 'nexora'],
    );
  }

  private async removeQueue(macAddress: string): Promise<void> {
    const queues = await this.write(['/queue/simple/print']);
    for (const row of queues) {
      if (String(row['name'] ?? '') === queueName(macAddress)) {
        await this.write(['/queue/simple/remove'], ['.id', String(row['.id'])]);
      }
    }
  }
}

function queueName(macAddress: string): string {
  return `nexora-${macAddress.replaceAll(':', '')}`;
}

function maxLimitToRateLimit(maxLimit: string): { downloadKbps: number; uploadKbps: number } {
  const [down, up] = maxLimit.split('/');
  return { downloadKbps: parseBandwidth(down), uploadKbps: parseBandwidth(up) };
}

function parseBandwidth(value: string | undefined): number {
  if (value === undefined) return 0;
  const match = /^(\d+)([kM]?)$/.exec(value);
  if (match === null) return 0;
  const multiplier = match[2] === 'M' ? 1000 : 1;
  return Number(match[1]) * multiplier;
}

function parseUptime(value: string | null): number | null {
  if (value === null) return null;
  let seconds = 0;
  for (const [regex, factor] of [
    [/(\d+)w/, 604800],
    [/(\d+)d/, 86400],
    [/(\d+)h/, 3600],
    [/(\d+)m(?!s)/, 60],
    [/(\d+)s/, 1],
  ] as const) {
    const match = regex.exec(value);
    if (match !== null) seconds += Number(match[1]) * factor;
  }
  return seconds;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}
