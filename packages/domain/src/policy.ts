/**
 * Effective policy resolution (architecture map §12, §109).
 *
 * Pure function — the deterministic core of the control loop. Inputs are the
 * subscription's immutable package-policy snapshot plus the current FUP state;
 * the output is the rate limit to enforce on the network.
 */

import type { FupStatus } from './state-machines.js';

export interface PackagePolicySnapshot {
  readonly downloadKbps: number;
  readonly uploadKbps: number;
  readonly burstDownloadKbps?: number | null;
  readonly burstUploadKbps?: number | null;
  readonly fupLimitBytes?: bigint | null;
  readonly fupWarningPercent?: number;
  readonly fupThrottleDownloadKbps?: number | null;
  readonly fupThrottleUploadKbps?: number | null;
  readonly sessionTimeLimitSeconds?: number | null;
}

export interface EffectiveRateLimit {
  readonly downloadKbps: number;
  readonly uploadKbps: number;
  readonly burstDownloadKbps: number | null;
  readonly burstUploadKbps: number | null;
  readonly sessionTimeLimitSeconds: number | null;
  readonly throttled: boolean;
  readonly reason: 'PACKAGE' | 'FUP' | 'SUSPENDED';
}

export interface PolicyResolutionContext {
  readonly fupStatus: FupStatus;
  readonly subscriptionSuspended: boolean;
  readonly authorized: boolean;
}

export function resolveEffectiveRateLimit(
  policy: PackagePolicySnapshot,
  context: PolicyResolutionContext,
): EffectiveRateLimit {
  const burstDown = policy.burstDownloadKbps ?? null;
  const burstUp = policy.burstUploadKbps ?? null;
  const sessionLimit = policy.sessionTimeLimitSeconds ?? null;

  if (context.subscriptionSuspended || !context.authorized) {
    return {
      downloadKbps: 0,
      uploadKbps: 0,
      burstDownloadKbps: null,
      burstUploadKbps: null,
      sessionTimeLimitSeconds: 0,
      throttled: true,
      reason: 'SUSPENDED',
    };
  }

  if (context.fupStatus === 'THROTTLED') {
    return {
      downloadKbps: policy.fupThrottleDownloadKbps ?? Math.floor(policy.downloadKbps / 4),
      uploadKbps: policy.fupThrottleUploadKbps ?? Math.floor(policy.uploadKbps / 4),
      burstDownloadKbps: null,
      burstUploadKbps: null,
      sessionTimeLimitSeconds: sessionLimit,
      throttled: true,
      reason: 'FUP',
    };
  }

  return {
    downloadKbps: policy.downloadKbps,
    uploadKbps: policy.uploadKbps,
    burstDownloadKbps: burstDown,
    burstUploadKbps: burstUp,
    sessionTimeLimitSeconds: sessionLimit,
    throttled: false,
    reason: 'PACKAGE',
  };
}

/** Next FUP state given usage against the limit (§20). Pure. */
export function evaluateFupState(input: {
  readonly current: FupStatus;
  readonly usedBytes: bigint;
  readonly limitBytes: bigint | null;
  readonly warningPercent: number;
}): FupStatus {
  if (input.limitBytes === null || input.limitBytes === 0n) {
    return 'NORMAL';
  }
  const ratio = Number((input.usedBytes * 100n) / input.limitBytes);
  if (ratio >= 100) {
    // Usage at/over the limit: WARNED states escalate to FUP_REACHED; the
    // THROTTLE action latches (and FUP_REACHED promotes to THROTTLED so the
    // policy transition engine applies reduced speeds on the next cycle).
    return input.current === 'NORMAL' || input.current === 'WARNING' ? 'FUP_REACHED' : 'THROTTLED';
  }
  if (ratio >= input.warningPercent) return 'WARNING';
  return 'NORMAL';
}
