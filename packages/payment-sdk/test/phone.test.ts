import { describe, expect, it } from 'vitest';
import { isValidKenyanMsisdn, normalizeKenyanMsisdn } from '@nexora/payment-sdk';

describe('MSISDN normalization', () => {
  it.each([
    ['0712345678', '254712345678'],
    ['+254712345678', '254712345678'],
    ['254712345678', '254712345678'],
    ['712345678', '254712345678'],
    ['0110123456', '254110123456'],
    ['0712-345-678', '254712345678'],
  ])('normalizes %s -> %s', (input, expected) => {
    expect(normalizeKenyanMsisdn(input)).toBe(expected);
  });

  it.each([
    ['12345'],
    ['25471234567'], // too short
    ['2547123456789'], // too long
    ['abcdefghij'],
    ['+254812345678'], // invalid prefix 8
    [''],
  ])('rejects %s', (input) => {
    expect(normalizeKenyanMsisdn(input)).toBeNull();
  });

  it('validates canonical form', () => {
    expect(isValidKenyanMsisdn('254712345678')).toBe(true);
    expect(isValidKenyanMsisdn('254112345678')).toBe(true);
    expect(isValidKenyanMsisdn('0712345678')).toBe(false);
    expect(isValidKenyanMsisdn('254812345678')).toBe(false);
  });
});
