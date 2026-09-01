/**
 * Argon2id password hashing (ADR-006).
 * OWASP baseline parameters: m=19456 KiB, t=2, p=1.
 */

import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { PasswordHasher } from './ports.js';

const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export class Argon2PasswordHasher implements PasswordHasher {
  public async hash(password: string): Promise<string> {
    return await argon2Hash(password, ARGON2_OPTIONS);
  }

  public async verify(password: string, passwordHash: string): Promise<boolean> {
    try {
      return await argon2Verify(passwordHash, password);
    } catch {
      // Malformed stored hash — treat as failed verification, never throw raw.
      return false;
    }
  }
}
