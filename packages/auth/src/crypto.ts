/**
 * Symmetric secret encryption for tenant-supplied credentials (ADR-013).
 *
 * Tenants bring their own M-Pesa Daraja API keys. Unlike router passwords
 * (which are Railway variable references, ADR-008), self-service tenant
 * secrets arrive at runtime and must be stored — so they are encrypted at
 * rest with AES-256-GCM under a single master key (CREDENTIALS_ENCRYPTION_KEY).
 *
 * The master key may be any string of length >= 32; it is folded to a 32-byte
 * key with SHA-256 so operators can use `openssl rand -hex 32` or a long
 * passphrase interchangeably. Ciphertext is self-describing:
 *
 *     v1.<iv_b64url>.<tag_b64url>.<ciphertext_b64url>
 *
 * Plaintext is never logged and never returned by any API — presence booleans
 * only (mirroring the payment-config discipline).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12; // GCM standard nonce length

export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretCryptoError';
  }
}

/** Minimum accepted master-key length. Shorter keys are rejected at boot. */
export const MIN_MASTER_KEY_LENGTH = 32;

function deriveKey(masterKey: string): Buffer {
  if (masterKey.length < MIN_MASTER_KEY_LENGTH) {
    throw new SecretCryptoError(
      `CREDENTIALS_ENCRYPTION_KEY must be at least ${MIN_MASTER_KEY_LENGTH} characters.`,
    );
  }
  return createHash('sha256').update(masterKey, 'utf8').digest();
}

/** Encrypts a UTF-8 secret. Returns the self-describing token string. */
export function encryptSecret(plaintext: string, masterKey: string): string {
  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Decrypts a token produced by encryptSecret. Throws on tamper/wrong key. */
export function decryptSecret(token: string, masterKey: string): string {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretCryptoError('Malformed ciphertext token.');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const key = deriveKey(masterKey);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64!, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64!, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64!, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretCryptoError('Decryption failed — wrong key or corrupted ciphertext.');
  }
}

/** True when the token looks like our ciphertext (does not verify the key). */
export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(`${VERSION}.`) && value.split('.').length === 4;
}
