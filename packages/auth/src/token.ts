/**
 * Session tokens (Stage 2).
 *
 * Format: base64url(payload).base64url(HMAC-SHA256(payload)) — stateless
 * verification with SESSION_SECRET. Staff ('user') tokens are additionally
 * tracked in a SessionStore (hash only) so they can be revoked; customer
 * tokens are stateless with short expiry (TD-004 tracks store-backed
 * customer sessions).
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IssuedToken, IssueMeta, TokenPayload, TokenService } from './ports.js';

export interface SessionStoreRecord {
  readonly subjectType: 'user' | 'customer';
  readonly subjectId: string;
  readonly expiresAt: Date;
}

export interface SessionStore {
  save(record: { tokenHash: string; payload: TokenPayload; expiresAt: Date; ip?: string; userAgent?: string }): Promise<void>;
  findActive(tokenHash: string): Promise<SessionStoreRecord | null>;
  revoke(tokenHash: string): Promise<void>;
}

const b64u = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

export class HmacTokenService implements TokenService {
  private readonly secret: string;
  private readonly sessionStore: SessionStore;
  private readonly ttlSeconds: number;

  constructor(options: { secret: string; sessionStore: SessionStore; ttlSeconds: number }) {
    this.secret = options.secret;
    this.sessionStore = options.sessionStore;
    this.ttlSeconds = options.ttlSeconds;
  }

  public async issue(payload: TokenPayload, meta?: IssueMeta): Promise<IssuedToken> {
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const body = { ...payload, exp: Math.floor(expiresAt.getTime() / 1000) };
    const encoded = b64u(JSON.stringify(body));
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url');
    const token = `nxs_${encoded}.${signature}`;

    await this.sessionStore.save({
      tokenHash: hashToken(token),
      payload,
      expiresAt,
      ...(meta?.ip !== undefined ? { ip: meta.ip } : {}),
      ...(meta?.userAgent !== undefined ? { userAgent: meta.userAgent } : {}),
    });

    return { token, expiresAt };
  }

  public async verify(token: string): Promise<TokenPayload> {
    const payload = verifyTokenSignature(token, this.secret);
    if (payload === null) {
      throw new TokenError('INVALID_TOKEN');
    }
    if (payload.exp * 1000 <= Date.now()) {
      throw new TokenError('TOKEN_EXPIRED');
    }
    // Staff sessions are revocable — check the store.
    if (payload.subjectType === 'user') {
      const record = await this.sessionStore.findActive(hashToken(token));
      if (record === null) {
        throw new TokenError('TOKEN_REVOKED');
      }
    }
    return { subjectType: payload.subjectType, subjectId: payload.subjectId, role: payload.role };
  }

  public async revoke(token: string): Promise<void> {
    await this.sessionStore.revoke(hashToken(token));
  }
}

interface StoredTokenPayload extends TokenPayload {
  readonly exp: number;
}

export function verifyTokenSignature(token: string, secret: string): StoredTokenPayload | null {
  if (!token.startsWith('nxs_')) return null;
  const rest = token.slice(4);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0) return null;
  const encoded = rest.slice(0, dot);
  const signature = rest.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StoredTokenPayload;
  } catch {
    return null;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type TokenErrorCode = 'INVALID_TOKEN' | 'TOKEN_EXPIRED' | 'TOKEN_REVOKED';

export class TokenError extends Error {
  public readonly code: TokenErrorCode;
  constructor(code: TokenErrorCode) {
    super(code);
    this.name = 'TokenError';
    this.code = code;
  }
}
