/**
 * Prisma-backed SessionStore for staff token revocation (UserSession table).
 * Customer tokens remain stateless (TD-004).
 */

import type { PrismaClient } from '@prisma/client';
import { hashToken, type SessionStore, type SessionStoreRecord } from '@nexora/auth';

export function prismaSessionStore(prisma: PrismaClient): SessionStore {
  return {
    async save({ tokenHash, payload, expiresAt, ip, userAgent }) {
      if (payload.subjectType !== 'user') return; // customer tokens are stateless
      await prisma.userSession.create({
        data: {
          tokenHash,
          userId: payload.subjectId,
          expiresAt,
          ...(ip !== undefined ? { ip } : {}),
          ...(userAgent !== undefined ? { userAgent } : {}),
        },
      });
    },
    async findActive(tokenHash: string): Promise<SessionStoreRecord | null> {
      const session = await prisma.userSession.findUnique({
        where: { tokenHash },
        select: { userId: true, expiresAt: true, revokedAt: true },
      });
      if (session === null || session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
        return null;
      }
      return { subjectType: 'user', subjectId: session.userId, expiresAt: session.expiresAt };
    },
    async revoke(tokenHash: string) {
      await prisma.userSession.updateMany({
        where: { tokenHash },
        data: { revokedAt: new Date() },
      });
    },
  };
}

export { hashToken };
