import { describe, expect, it } from 'vitest';
import { computeDelta } from '@nexora/engines';
import { isExpirable } from '@nexora/engines';

describe('computeDelta — counter rollover protection (§19)', () => {
  it('first observation establishes baseline (no delta)', () => {
    expect(computeDelta(null, 1000n)).toEqual({ delta: 0n, resetSuspected: false });
    expect(computeDelta(null, null)).toEqual({ delta: 0n, resetSuspected: false });
  });

  it('positive delta', () => {
    expect(computeDelta(1000n, 1500n)).toEqual({ delta: 500n, resetSuspected: false });
    expect(computeDelta(1000n, 1000n)).toEqual({ delta: 0n, resetSuspected: false });
  });

  it('decreasing counter → reset suspected, zero delta (never negative)', () => {
    expect(computeDelta(5000n, 100n)).toEqual({ delta: 0n, resetSuspected: true });
    expect(computeDelta(5000n, 4999n)).toEqual({ delta: 0n, resetSuspected: true });
  });
});

describe('isExpirable (§21)', () => {
  const now = new Date('2026-09-01T12:00:00Z');
  const past = new Date('2026-09-01T11:00:00Z');
  const future = new Date('2026-09-02T12:00:00Z');

  it('expires ACTIVE/FUP/SUSPENDED/PROVISIONING_FAILED past expiry', () => {
    expect(isExpirable('ACTIVE', past, now)).toBe(true);
    expect(isExpirable('FUP', past, now)).toBe(true);
    expect(isExpirable('SUSPENDED', past, now)).toBe(true);
    expect(isExpirable('PROVISIONING_FAILED', past, now)).toBe(true);
  });

  it('never expires terminal or future-dated subscriptions', () => {
    expect(isExpirable('EXPIRED', past, now)).toBe(false);
    expect(isExpirable('CANCELLED', past, now)).toBe(false);
    expect(isExpirable('ACTIVE', future, now)).toBe(false);
    expect(isExpirable('ACTIVE', null, now)).toBe(false);
  });
});
