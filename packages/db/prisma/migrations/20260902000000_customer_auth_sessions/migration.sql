-- CustomerAuthSession: revocable customer tokens (TD-004)

CREATE TABLE "CustomerAuthSession" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerAuthSession_pkey" PRIMARY KEY ("id")
);

-- @@unique([tokenHash])
CREATE UNIQUE INDEX "CustomerAuthSession_tokenHash_key" ON "CustomerAuthSession"("tokenHash");

-- @@index([customerId, expiresAt])
CREATE INDEX "CustomerAuthSession_customerId_expiresAt_idx" ON "CustomerAuthSession"("customerId", "expiresAt");

-- AddForeignKey
ALTER TABLE "CustomerAuthSession" ADD CONSTRAINT "CustomerAuthSession_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
