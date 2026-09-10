import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, isEncryptedSecret, SecretCryptoError } from '@nexora/auth';

const KEY = 'unit-test-master-key-that-is-long-enough-0123456789';

describe('secret crypto (AES-256-GCM)', () => {
  it('round-trips a secret', () => {
    const token = encryptSecret('daraja-consumer-secret', KEY);
    expect(token.startsWith('v1.')).toBe(true);
    expect(decryptSecret(token, KEY)).toBe('daraja-consumer-secret');
  });

  it('produces a distinct ciphertext each call (random IV)', () => {
    expect(encryptSecret('same', KEY)).not.toBe(encryptSecret('same', KEY));
  });

  it('rejects a wrong key', () => {
    const token = encryptSecret('x', KEY);
    expect(() => decryptSecret(token, KEY.replace('0', '9'))).toThrow(SecretCryptoError);
  });

  it('rejects tampered ciphertext', () => {
    const token = encryptSecret('x', KEY);
    const parts = token.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), KEY)).toThrow(SecretCryptoError);
  });

  it('rejects a short master key', () => {
    expect(() => encryptSecret('x', 'too-short')).toThrow(SecretCryptoError);
  });

  it('recognises its own ciphertext format', () => {
    expect(isEncryptedSecret(encryptSecret('x', KEY))).toBe(true);
    expect(isEncryptedSecret('plaintext')).toBe(false);
    expect(isEncryptedSecret(null)).toBe(false);
  });
});
