-- Multi-tenancy + payment lifecycle (companies, platform owner, paybill/till,
-- cancelled/complete/timeout payment closure). See docs/MULTI_TENANCY.md and
-- docs/PAYMENTS.md.

-- ---------------------------------------------------------------------------
-- New enums
-- ---------------------------------------------------------------------------
CREATE TYPE "TenantStatus" AS ENUM ('TRIAL', 'ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE "MpesaChannel" AS ENUM ('PAYBILL', 'TILL');

-- Extend existing enums (PG12+: safe outside/inside a tx as long as the new
-- value is not referenced in the same transaction — it is not here).
ALTER TYPE "AdminRole" ADD VALUE IF NOT EXISTS 'PLATFORM_OWNER';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

-- ---------------------------------------------------------------------------
-- Tenant table
-- ---------------------------------------------------------------------------
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'TRIAL',
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "country" TEXT NOT NULL DEFAULT 'KE',
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "supportPhone" TEXT,
    "supportEmail" TEXT,
    "primaryColor" TEXT,
    "mpesaChannel" "MpesaChannel" NOT NULL DEFAULT 'PAYBILL',
    "mpesaEnv" TEXT NOT NULL DEFAULT 'sandbox',
    "mpesaShortcode" TEXT,
    "mpesaPartyB" TEXT,
    "mpesaCallbackUrl" TEXT,
    "mpesaPasskeyEnc" TEXT,
    "mpesaConsumerKeyEnc" TEXT,
    "mpesaConsumerSecretEnc" TEXT,
    "mpesaConfiguredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");
CREATE INDEX "Tenant_status_idx" ON "Tenant"("status");

-- Reserved tenants. `default` backfills every pre-existing row (all of which
-- carry tenantId = 'default'); `platform` hosts the PLATFORM_OWNER.
INSERT INTO "Tenant" ("id", "slug", "name", "status", "contactEmail", "updatedAt")
VALUES
    ('default', 'default', 'Default ISP', 'ACTIVE', 'ops@nexora.local', CURRENT_TIMESTAMP),
    ('platform', 'platform', 'NEXORA Platform', 'ACTIVE', 'owner@nexora.local', CURRENT_TIMESTAMP);

-- ---------------------------------------------------------------------------
-- tenantId columns on previously-untenanted tables
-- ---------------------------------------------------------------------------
ALTER TABLE "User" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Payment" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Payment" ADD COLUMN "deadlineAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'default';

CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");
CREATE INDEX "Payment_status_deadlineAt_idx" ON "Payment"("status", "deadlineAt");
CREATE INDEX "Payment_tenantId_status_idx" ON "Payment"("tenantId", "status");

-- ---------------------------------------------------------------------------
-- Foreign keys to Tenant (all existing rows already point at 'default')
-- ---------------------------------------------------------------------------
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Package" ADD CONSTRAINT "Package_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Router" ADD CONSTRAINT "Router_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
