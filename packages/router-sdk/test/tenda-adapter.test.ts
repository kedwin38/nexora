import { describe, expect, it } from 'vitest';
import { TendaAdapter } from '@nexora/router-sdk';
import { CapabilityNotSupportedError } from '@nexora/router-sdk';

const connection = {
  host: '192.168.0.1',
  port: 80,
  username: 'admin',
  passwordEnvVar: 'TENDA_PASSWORD',
  timeoutMs: 500,
};

const state = {
  macAddress: 'AA:BB:CC:DD:EE:FF',
  authorized: true,
  rateLimit: null,
  sessionTimeLimitSeconds: null,
};

describe('TendaAdapter skeleton contract', () => {
  it('declares CAP_HEALTH only', () => {
    const adapter = new TendaAdapter(connection);
    expect(adapter.getCapabilities()).toEqual(['CAP_HEALTH']);
    expect(adapter.vendor).toBe('tenda');
  });

  it.each([
    ['authorizeSubscriber', [state]] as const,
    ['deauthorizeSubscriber', ['AA:BB:CC:DD:EE:FF']] as const,
    ['applyPolicy', [state]] as const,
    ['removePolicy', ['AA:BB:CC:DD:EE:FF']] as const,
    ['disconnectSession', ['AA:BB:CC:DD:EE:FF']] as const,
    ['getActiveSessions', []] as const,
    ['getUsage', ['AA:BB:CC:DD:EE:FF']] as const,
    ['reconcileSubscriber', [state]] as const,
  ])('%s throws CapabilityNotSupportedError — never a silent no-op', async (method, args) => {
    const adapter = new TendaAdapter(connection);
    await expect(
      (adapter[method] as (...a: unknown[]) => Promise<unknown>)(...args),
    ).rejects.toThrow(CapabilityNotSupportedError);
  });

  it('healthCheck returns a report (offline for unreachable hosts)', async () => {
    const adapter = new TendaAdapter(connection);
    const report = await adapter.healthCheck();
    expect(report).toHaveProperty('online');
    expect(report.cpuPercent).toBeNull();
  });
});
