import { describe, expect, it } from 'vitest';
import { evaluateFupState, resolveEffectiveRateLimit } from '@nexora/domain';

const basePolicy = {
  downloadKbps: 5120,
  uploadKbps: 2560,
  burstDownloadKbps: 7168,
  burstUploadKbps: 3584,
  fupLimitBytes: 5n * 1024n ** 3n,
  fupWarningPercent: 80,
  fupThrottleDownloadKbps: 1024,
  fupThrottleUploadKbps: 512,
} as const;

describe('resolveEffectiveRateLimit', () => {
  it('returns package speeds when healthy', () => {
    const result = resolveEffectiveRateLimit(basePolicy, {
      fupStatus: 'NORMAL',
      subscriptionSuspended: false,
      authorized: true,
    });
    expect(result).toMatchObject({
      downloadKbps: 5120,
      uploadKbps: 2560,
      throttled: false,
      reason: 'PACKAGE',
    });
  });

  it('applies FUP throttle speeds when THROTTLED', () => {
    const result = resolveEffectiveRateLimit(basePolicy, {
      fupStatus: 'THROTTLED',
      subscriptionSuspended: false,
      authorized: true,
    });
    expect(result).toMatchObject({
      downloadKbps: 1024,
      uploadKbps: 512,
      throttled: true,
      reason: 'FUP',
    });
  });

  it('falls back to quarter speed when package has no explicit throttle', () => {
    const result = resolveEffectiveRateLimit(
      { ...basePolicy, fupThrottleDownloadKbps: null, fupThrottleUploadKbps: null },
      { fupStatus: 'THROTTLED', subscriptionSuspended: false, authorized: true },
    );
    expect(result.downloadKbps).toBe(1280); // 5120 / 4
    expect(result.uploadKbps).toBe(640); // 2560 / 4
  });

  it('zeroes everything when suspended or unauthorized', () => {
    for (const ctx of [
      { fupStatus: 'NORMAL' as const, subscriptionSuspended: true, authorized: true },
      { fupStatus: 'NORMAL' as const, subscriptionSuspended: false, authorized: false },
    ]) {
      const result = resolveEffectiveRateLimit(basePolicy, ctx);
      expect(result.downloadKbps).toBe(0);
      expect(result.uploadKbps).toBe(0);
      expect(result.reason).toBe('SUSPENDED');
    }
  });

  it('WARNING state still yields package speeds (warning is informational)', () => {
    const result = resolveEffectiveRateLimit(basePolicy, {
      fupStatus: 'WARNING',
      subscriptionSuspended: false,
      authorized: true,
    });
    expect(result.throttled).toBe(false);
  });
});

describe('evaluateFupState', () => {
  const limit = 1000n;

  it('stays NORMAL with no limit configured', () => {
    expect(evaluateFupState({ current: 'WARNING', usedBytes: 99999n, limitBytes: null, warningPercent: 80 })).toBe(
      'NORMAL',
    );
  });

  it('NORMAL -> WARNING at threshold', () => {
    expect(evaluateFupState({ current: 'NORMAL', usedBytes: 800n, limitBytes: limit, warningPercent: 80 })).toBe(
      'WARNING',
    );
  });

  it('WARNING -> FUP_REACHED at 100%', () => {
    expect(evaluateFupState({ current: 'WARNING', usedBytes: 1000n, limitBytes: limit, warningPercent: 80 })).toBe(
      'FUP_REACHED',
    );
  });

  it('FUP_REACHED promotes to THROTTLED (throttle action latches)', () => {
    expect(evaluateFupState({ current: 'FUP_REACHED', usedBytes: 1000n, limitBytes: limit, warningPercent: 80 })).toBe(
      'THROTTLED',
    );
  });

  it('latches THROTTLED while usage stays over limit', () => {
    expect(evaluateFupState({ current: 'THROTTLED', usedBytes: 1200n, limitBytes: limit, warningPercent: 80 })).toBe(
      'THROTTLED',
    );
  });

  it('recovers to NORMAL after usage drops (post-reset)', () => {
    expect(evaluateFupState({ current: 'THROTTLED', usedBytes: 100n, limitBytes: limit, warningPercent: 80 })).toBe(
      'NORMAL',
    );
  });
});
