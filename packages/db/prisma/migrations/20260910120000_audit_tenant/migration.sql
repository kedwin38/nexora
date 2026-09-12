-- Tenant-scope the audit trail (autopsy F10). Company admins see only their
-- own tenant's audit entries; the platform owner sees all.

ALTER TABLE "AuditLog" ADD COLUMN "tenantId" TEXT;

-- All pre-existing audit rows belong to the reference `default` company.
UPDATE "AuditLog" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;

CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");
