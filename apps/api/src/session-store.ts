/**
 * Prisma-backed SessionStore — revocable tokens for BOTH staff (UserSession)
 * and customers (CustomerAuthSession). Token hashes only; never plaintext.
 */

import type { PrismaClient } from '@prisma/client';
import { hashToken, type SessionStore, type SessionStoreRecord } from '@nexora/auth';

export function prismaSessionStore(prisma: PrismaClient): SessionStore {
  return {
    async save({ tokenHash, payload, expiresAt, ip, userAgent }) {
      const common = {
        tokenHash,
        expiresAt,
        ...(ip !== undefined ? { ip } : {}),
        ...(userAgent !== undefined ? { userAgent } : {}),
      };
      if (payload.subjectType === 'user') {
        await prisma.userSession.create({
          data: { ...common, userId: payload.subjectId },
        });
      } else {
        await prisma.customerAuthSession.create({
          data: { ...common, customerId: payload.subjectId },
        });
      }
    },
    async findActive(tokenHash: string): Promise<SessionStoreRecord | null> {
      const staff = await prisma.userSession.findUnique({
        where: { tokenHash },
        select: { userId: true, expiresAt: true, revokedAt: true },
      });
      if (staff !== null) {
        if (staff.revokedAt !== null || staff.expiresAt.getTime() <= Date.now()) return null;
        return { subjectType: 'user', subjectId: staff.userId, expiresAt: staff.expiresAt };
      }
      const customer = await prisma.customerAuthSession.findUnique({
        where: { tokenHash },
        select: { customerId: true, expiresAt: true, revokedAt: true },
      });
      if (customer === null) return null;
      if (customer.revokedAt !== null || customer.expiresAt.getTime() <= Date.now()) return null;
      return { subjectType: 'customer', subjectId: customer.customerId, expiresAt: customer.expiresAt };
    },
    async revoke(tokenHash: string) {
      await prisma.userSession.updateMany({
        where: { tokenHash },
        data: { revokedAt: new Date() },
      });
      await prisma.customerAuthSession.updateMany({
        where: { tokenHash },
        data: { revokedAt: new Date() },
      });
    },
  };
}

export { hashToken };
