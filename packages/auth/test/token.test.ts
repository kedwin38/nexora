import { describe, expect, it } from 'vitest';
import {
  Argon2PasswordHasher,
  HmacTokenService,
  hashToken,
  TokenError,
  verifyTokenSignature,
  type SessionStore,
  type SessionStoreRecord,
} from '@nexora/auth';

function memoryStore(): SessionStore & { records: Map<string, SessionStoreRecord & { revoked: boolean }> } {
  const records = new Map<string, SessionStoreRecord & { revoked: boolean }>();
  return {
    records,
    async save({ tokenHash, payload, expiresAt }) {
      records.set(tokenHash, {
        subjectType: payload.subjectType,
        subjectId: payload.subjectId,
        expiresAt,
        revoked: false,
      });
    },
    async findActive(tokenHash) {
      const record = records.get(tokenHash);
      if (record === undefined || record.revoked || record.expiresAt.getTime() <= Date.now()) return null;
      return record;
    },
    async revoke(tokenHash) {
      const record = records.get(tokenHash);
      if (record !== undefined) record.revoked = true;
    },
  };
}

describe('Argon2PasswordHasher', () => {
  it('hashes and verifies round-trip', async () => {
    const hasher = new Argon2PasswordHasher();
    const digest = await hasher.hash('correct horse battery staple');
    expect(digest.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify('correct horse battery staple', digest)).toBe(true);
    expect(await hasher.verify('wrong password', digest)).toBe(false);
  });

  it('swallows malformed hashes as failed verification', async () => {
    const hasher = new Argon2PasswordHasher();
    expect(await hasher.verify('x', 'not-a-hash')).toBe(false);
  });
});

describe('HmacTokenService', () => {
  const secret = 'unit-test-secret-value-0123456789abcdef';

  it('issues verifiable tokens with payload intact', async () => {
    const service = new HmacTokenService({ secret, sessionStore: memoryStore(), ttlSeconds: 60 });
    const issued = await service.issue({ subjectType: 'user', subjectId: 'u1', role: 'SUPER_ADMIN' });
    expect(issued.token.startsWith('nxs_')).toBe(true);
    const payload = await service.verify(issued.token);
    expect(payload).toMatchObject({ subjectType: 'user', subjectId: 'u1', role: 'SUPER_ADMIN' });
  });

  it('rejects tampered tokens', async () => {
    const service = new HmacTokenService({ secret, sessionStore: memoryStore(), ttlSeconds: 60 });
    const issued = await service.issue({ subjectType: 'customer', subjectId: 'c1', role: 'CUSTOMER' });
    const tampered = `${issued.token.slice(0, -3)}abc`;
    await expect(service.verify(tampered)).rejects.toThrow(TokenError);
  });

  it('rejects tokens signed with a different secret', async () => {
    const store = memoryStore();
    const issuer = new HmacTokenService({ secret, sessionStore: store, ttlSeconds: 60 });
    const verifier = new HmacTokenService({ secret: 'other-secret', sessionStore: store, ttlSeconds: 60 });
    const issued = await issuer.issue({ subjectType: 'customer', subjectId: 'c1', role: 'CUSTOMER' });
    await expect(verifier.verify(issued.token)).rejects.toThrow(TokenError);
  });

  it('rejects expired tokens', async () => {
    const service = new HmacTokenService({ secret, sessionStore: memoryStore(), ttlSeconds: -1 });
    const issued = await service.issue({ subjectType: 'customer', subjectId: 'c1', role: 'CUSTOMER' });
    await expect(service.verify(issued.token)).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
  });

  it('revokes staff sessions via the store', async () => {
    const store = memoryStore();
    const service = new HmacTokenService({ secret, sessionStore: store, ttlSeconds: 60 });
    const issued = await service.issue({ subjectType: 'user', subjectId: 'u1', role: 'SUPPORT_AGENT' });
    await service.verify(issued.token); // active
    await service.revoke(issued.token);
    await expect(service.verify(issued.token)).rejects.toMatchObject({ code: 'TOKEN_REVOKED' });
  });

  it('verifyTokenSignature is pure and rejects garbage', () => {
    expect(verifyTokenSignature('garbage', secret)).toBeNull();
    expect(verifyTokenSignature('nxs_nodots', secret)).toBeNull();
    expect(verifyTokenSignature('', secret)).toBeNull();
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});
