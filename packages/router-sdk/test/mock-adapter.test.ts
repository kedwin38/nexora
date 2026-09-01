import { describe, expect, it } from 'vitest';
import { MockRouterAdapter } from '@nexora/router-sdk';

const state = (mac: string, over?: Partial<Parameters<MockRouterAdapter['authorizeSubscriber']>[0]>) => ({
  macAddress: mac,
  authorized: true,
  rateLimit: { downloadKbps: 5120, uploadKbps: 2560, burstDownloadKbps: null, burstUploadKbps: null },
  sessionTimeLimitSeconds: null,
  ...over,
});

describe('MockRouterAdapter contract', () => {
  it('authorize is idempotent — same MAC, same final state', async () => {
    const router = new MockRouterAdapter();
    const mac = router.newMac();
    await router.authorizeSubscriber(state(mac));
    await router.authorizeSubscriber(state(mac));
    const sessions = await router.getActiveSessions();
    expect(sessions.filter((s) => s.macAddress === mac)).toHaveLength(1);
  });

  it('read-back matches after authorize, reports drift after policy change', async () => {
    const router = new MockRouterAdapter();
    const mac = router.newMac();
    const desired = state(mac);
    await router.authorizeSubscriber(desired);

    const clean = await router.reconcileSubscriber(desired);
    expect(clean.matchesDesired).toBe(true);

    const drifted = await router.reconcileSubscriber(
      state(mac, { rateLimit: { downloadKbps: 1024, uploadKbps: 512, burstDownloadKbps: null, burstUploadKbps: null } }),
    );
    expect(drifted.matchesDesired).toBe(false);
  });

  it('reconcile of unknown subscriber returns null state', async () => {
    const router = new MockRouterAdapter();
    const report = await router.reconcileSubscriber(state('AA:BB:CC:DD:EE:FF'));
    expect(report.subscriberState).toBeNull();
    expect(report.matchesDesired).toBeNull();
  });

  it('deauthorize removes state and session', async () => {
    const router = new MockRouterAdapter();
    const mac = router.newMac();
    await router.authorizeSubscriber(state(mac));
    await router.deauthorizeSubscriber(mac);
    expect(router.snapshotState(mac)).toBeUndefined();
    expect((await router.getActiveSessions()).find((s) => s.macAddress === mac)).toBeUndefined();
  });

  it('reports healthy and exposes full capability set', async () => {
    const router = new MockRouterAdapter();
    const health = await router.healthCheck();
    expect(health.online).toBe(true);
    expect(router.getCapabilities()).toContain('CAP_POLICY_READBACK');
  });

  it('usage counters round-trip', async () => {
    const router = new MockRouterAdapter();
    const mac = router.newMac();
    router.seedUsage(mac, 123456, 654321);
    const usage = await router.getUsage(mac);
    expect(usage).toMatchObject({ downloadBytes: 123456, uploadBytes: 654321, counterResetSuspected: false });
  });
});
