/**
 * Kenyan MSISDN normalization.
 *
 * Pure functions — unit tested. M-Pesa requires 2547XXXXXXXX / 2541XXXXXXXX.
 */

const KENYAN_MSISDN = /^254[17]\d{8}$/;

export function isValidKenyanMsisdn(input: string): boolean {
  return KENYAN_MSISDN.test(input);
}

/**
 * Normalizes 07…, 01…, +2547…, 2547… forms to 2547XXXXXXXX / 2541XXXXXXXX.
 * Returns null when the input cannot be normalized to a valid Kenyan MSISDN.
 */
export function normalizeKenyanMsisdn(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  const candidate: string | null = (() => {
    if (digits.startsWith('0') && digits.length === 10) {
      return `254${digits.slice(1)}`;
    }
    if (digits.startsWith('254') && digits.length === 12) {
      return digits;
    }
    if (digits.length === 9 && (digits.startsWith('7') || digits.startsWith('1'))) {
      return `254${digits}`;
    }
    return null;
  })();
  if (candidate === null || !isValidKenyanMsisdn(candidate)) {
    return null;
  }
  return candidate;
}
