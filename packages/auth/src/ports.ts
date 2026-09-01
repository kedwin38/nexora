/**
 * Authentication ports.
 *
 * Implementations are provided in Stage 2: Argon2id hashing (ADR-006) and a
 * signed session token service. Domains depend only on these interfaces.
 */

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export interface IssuedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface TokenPayload {
  readonly subjectType: 'user' | 'customer';
  readonly subjectId: string;
  readonly role: string;
}

export interface TokenService {
  issue(payload: TokenPayload): Promise<IssuedToken>;
  verify(token: string): Promise<TokenPayload>;
  revoke(token: string): Promise<void>;
}
