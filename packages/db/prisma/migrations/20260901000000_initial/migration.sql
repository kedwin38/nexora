-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('REGISTERED', 'GUEST');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'BLOCKED', 'DELETED');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'NETWORK_ADMIN', 'BILLING_ADMIN', 'SUPPORT_AGENT', 'ANALYST', 'READ_ONLY', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "AdminUserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "PackageStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "FupResetPolicy" AS ENUM ('NONE', 'DAILY', 'WEEKLY', 'MONTHLY', 'PERIOD');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'PROVISIONING', 'ACTIVE', 'FUP', 'SUSPENDED', 'EXPIRED', 'CANCELLED', 'PROVISIONING_FAILED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('MPESA');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REVERSED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentAttemptType" AS ENUM ('STK_PUSH', 'STATUS_QUERY', 'REVERSAL', 'CALLBACK');

-- CreateEnum
CREATE TYPE "PaymentAllocation" AS ENUM ('SUBSCRIPTION_PURCHASE', 'SUBSCRIPTION_RENEWAL');

-- CreateEnum
CREATE TYPE "RouterVendor" AS ENUM ('MIKROTIK', 'TENDA');

-- CreateEnum
CREATE TYPE "RouterStatus" AS ENUM ('ONLINE', 'DEGRADED', 'OFFLINE', 'MAINTENANCE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RouterCapabilityEnum" AS ENUM ('CAP_AUTH', 'CAP_DEAUTH', 'CAP_RATE_LIMIT', 'CAP_SESSION_CONTROL', 'CAP_USAGE', 'CAP_HEALTH', 'CAP_CLIENT_DISCOVERY', 'CAP_POLICY_READBACK');

-- CreateEnum
CREATE TYPE "NetworkOperationType" AS ENUM ('AUTHORIZE', 'DEAUTHORIZE', 'APPLY_POLICY', 'REMOVE_POLICY', 'DISCONNECT_SESSION', 'RECONCILE_SYNC');

-- CreateEnum
CREATE TYPE "NetworkOperationStatus" AS ENUM ('QUEUED', 'PROCESSING', 'VERIFYING', 'SUCCESS', 'RETRYING', 'PERMANENT_FAILURE');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('CREATED', 'AUTHENTICATING', 'AUTHORIZED', 'ONLINE', 'THROTTLED', 'DISCONNECTING', 'ENDED', 'FAILED');

-- CreateEnum
CREATE TYPE "FupStateEnum" AS ENUM ('NORMAL', 'WARNING', 'FUP_REACHED', 'THROTTLED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'DISPATCHED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "SystemEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'RETRYING', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'EMAIL', 'DASHBOARD', 'PUSH', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditResult" AS ENUM ('SUCCESS', 'FAILURE');

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "name" "AdminRole" NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "AdminUserStatus" NOT NULL DEFAULT 'ACTIVE',
    "roleId" TEXT NOT NULL,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "customerNumber" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "accountType" "AccountType" NOT NULL DEFAULT 'REGISTERED',
    "status" "CustomerStatus" NOT NULL DEFAULT 'PENDING',
    "phoneNumber" TEXT,
    "email" TEXT,
    "passwordHash" TEXT,
    "displayName" TEXT,
    "metadata" JSONB,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "macAddress" TEXT NOT NULL,
    "ipAddress" TEXT,
    "hostname" TEXT,
    "vendor" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestAccess" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "accessCode" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Package" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "priceMinor" INTEGER NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "PackageStatus" NOT NULL DEFAULT 'DRAFT',
    "maxDevices" INTEGER NOT NULL DEFAULT 1,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackagePolicy" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "downloadKbps" INTEGER NOT NULL,
    "uploadKbps" INTEGER NOT NULL,
    "burstDownloadKbps" INTEGER,
    "burstUploadKbps" INTEGER,
    "fupLimitBytes" BIGINT,
    "fupWarningPercent" INTEGER NOT NULL DEFAULT 80,
    "fupThrottleDownloadKbps" INTEGER,
    "fupThrottleUploadKbps" INTEGER,
    "fupResetPolicy" "FupResetPolicy" NOT NULL DEFAULT 'NONE',
    "sessionTimeLimitSeconds" INTEGER,
    "activeHoursStart" TEXT,
    "activeHoursEnd" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackagePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "subscriptionNumber" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "customerId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "packageVersion" INTEGER NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "startTime" TIMESTAMP(3),
    "expiryTime" TIMESTAMP(3),
    "billingPeriodStart" TIMESTAMP(3),
    "billingPeriodEnd" TIMESTAMP(3),
    "priceAtPurchaseMinor" INTEGER NOT NULL,
    "fupThresholdAtPurchaseBytes" BIGINT,
    "policySnapshot" JSONB NOT NULL,
    "paymentReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FupState" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "state" "FupStateEnum" NOT NULL DEFAULT 'NORMAL',
    "usedBytes" BIGINT NOT NULL DEFAULT 0,
    "limitBytes" BIGINT NOT NULL,
    "warningPercent" INTEGER NOT NULL DEFAULT 80,
    "periodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "lastEvaluatedAt" TIMESTAMP(3),
    "resetAt" TIMESTAMP(3),

    CONSTRAINT "FupState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'MPESA',
    "providerTransactionId" TEXT,
    "clientReference" TEXT,
    "customerId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "packageId" TEXT,
    "allocation" "PaymentAllocation",
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "phoneNumber" TEXT NOT NULL,
    "receipt" TEXT,
    "failureReason" TEXT,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "attemptType" "PaymentAttemptType" NOT NULL,
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "resultCode" TEXT,
    "resultDesc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Router" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "vendor" "RouterVendor" NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 8728,
    "username" TEXT NOT NULL,
    "passwordEnvVar" TEXT NOT NULL,
    "timeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "status" "RouterStatus" NOT NULL DEFAULT 'UNKNOWN',
    "site" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "healthPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Router_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouterCapabilityEntry" (
    "id" TEXT NOT NULL,
    "routerId" TEXT NOT NULL,
    "capability" "RouterCapabilityEnum" NOT NULL,
    "supported" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RouterCapabilityEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetworkPolicy" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "desiredState" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "synchronizedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NetworkPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetworkOperation" (
    "id" TEXT NOT NULL,
    "routerId" TEXT NOT NULL,
    "customerId" TEXT,
    "subscriptionId" TEXT,
    "operationType" "NetworkOperationType" NOT NULL,
    "desiredState" JSONB,
    "desiredStateVersion" INTEGER,
    "status" "NetworkOperationStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "correlationId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "verificationResult" JSONB,

    CONSTRAINT "NetworkOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerSession" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "routerId" TEXT,
    "deviceId" TEXT,
    "macAddress" TEXT NOT NULL,
    "ipAddress" TEXT,
    "status" "SessionStatus" NOT NULL DEFAULT 'CREATED',
    "downloadBytes" BIGINT NOT NULL DEFAULT 0,
    "uploadBytes" BIGINT NOT NULL DEFAULT 0,
    "terminationReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "CustomerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageSnapshot" (
    "id" TEXT NOT NULL,
    "routerId" TEXT NOT NULL,
    "sessionId" TEXT,
    "macAddress" TEXT NOT NULL,
    "counterDownload" BIGINT NOT NULL,
    "counterUpload" BIGINT NOT NULL,
    "counterResetSuspected" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "subscriptionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "intervalStart" TIMESTAMP(3) NOT NULL,
    "intervalEnd" TIMESTAMP(3) NOT NULL,
    "downloadBytes" BIGINT NOT NULL DEFAULT 0,
    "uploadBytes" BIGINT NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'ROUTER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "SystemEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "SystemEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "result" TEXT,
    "correlationId" TEXT,
    "workerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "beforeState" JSONB,
    "afterState" JSONB,
    "result" "AuditResult" NOT NULL DEFAULT 'SUCCESS',
    "ipAddress" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "triggerType" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scheduledFor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "error" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");

-- CreateIndex
CREATE INDEX "UserSession_userId_expiresAt_idx" ON "UserSession"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_customerNumber_key" ON "Customer"("customerNumber");

-- CreateIndex
CREATE INDEX "Customer_status_idx" ON "Customer"("status");

-- CreateIndex
CREATE INDEX "Customer_accountType_idx" ON "Customer"("accountType");

-- CreateIndex
CREATE INDEX "Customer_tenantId_idx" ON "Customer"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_tenantId_phoneNumber_key" ON "Customer"("tenantId", "phoneNumber");

-- CreateIndex
CREATE INDEX "Device_macAddress_idx" ON "Device"("macAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Device_customerId_macAddress_key" ON "Device"("customerId", "macAddress");

-- CreateIndex
CREATE UNIQUE INDEX "GuestAccess_customerId_key" ON "GuestAccess"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestAccess_accessCode_key" ON "GuestAccess"("accessCode");

-- CreateIndex
CREATE INDEX "GuestAccess_expiresAt_idx" ON "GuestAccess"("expiresAt");

-- CreateIndex
CREATE INDEX "Package_status_displayOrder_idx" ON "Package"("status", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Package_tenantId_name_version_key" ON "Package"("tenantId", "name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PackagePolicy_packageId_key" ON "PackagePolicy"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_subscriptionNumber_key" ON "Subscription"("subscriptionNumber");

-- CreateIndex
CREATE INDEX "Subscription_customerId_status_idx" ON "Subscription"("customerId", "status");

-- CreateIndex
CREATE INDEX "Subscription_status_expiryTime_idx" ON "Subscription"("status", "expiryTime");

-- CreateIndex
CREATE INDEX "FupState_state_idx" ON "FupState"("state");

-- CreateIndex
CREATE INDEX "FupState_periodEnd_idx" ON "FupState"("periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "FupState_subscriptionId_periodStart_key" ON "FupState"("subscriptionId", "periodStart");

-- CreateIndex
CREATE INDEX "Payment_customerId_status_idx" ON "Payment"("customerId", "status");

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_providerTransactionId_key" ON "Payment"("provider", "providerTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_clientReference_key" ON "Payment"("provider", "clientReference");

-- CreateIndex
CREATE INDEX "PaymentAttempt_paymentId_createdAt_idx" ON "PaymentAttempt"("paymentId", "createdAt");

-- CreateIndex
CREATE INDEX "Router_status_idx" ON "Router"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Router_tenantId_host_port_key" ON "Router"("tenantId", "host", "port");

-- CreateIndex
CREATE UNIQUE INDEX "RouterCapabilityEntry_routerId_capability_key" ON "RouterCapabilityEntry"("routerId", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "NetworkPolicy_subscriptionId_key" ON "NetworkPolicy"("subscriptionId");

-- CreateIndex
CREATE INDEX "NetworkPolicy_synchronizedAt_idx" ON "NetworkPolicy"("synchronizedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NetworkOperation_idempotencyKey_key" ON "NetworkOperation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "NetworkOperation_status_nextAttemptAt_idx" ON "NetworkOperation"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NetworkOperation_routerId_status_idx" ON "NetworkOperation"("routerId", "status");

-- CreateIndex
CREATE INDEX "NetworkOperation_subscriptionId_idx" ON "NetworkOperation"("subscriptionId");

-- CreateIndex
CREATE INDEX "CustomerSession_customerId_startedAt_idx" ON "CustomerSession"("customerId", "startedAt");

-- CreateIndex
CREATE INDEX "CustomerSession_macAddress_startedAt_idx" ON "CustomerSession"("macAddress", "startedAt");

-- CreateIndex
CREATE INDEX "CustomerSession_status_lastSeenAt_idx" ON "CustomerSession"("status", "lastSeenAt");

-- CreateIndex
CREATE INDEX "UsageSnapshot_routerId_collectedAt_idx" ON "UsageSnapshot"("routerId", "collectedAt");

-- CreateIndex
CREATE INDEX "UsageSnapshot_macAddress_collectedAt_idx" ON "UsageSnapshot"("macAddress", "collectedAt");

-- CreateIndex
CREATE INDEX "UsageRecord_subscriptionId_intervalStart_idx" ON "UsageRecord"("subscriptionId", "intervalStart");

-- CreateIndex
CREATE INDEX "UsageRecord_customerId_intervalStart_idx" ON "UsageRecord"("customerId", "intervalStart");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_idx" ON "OutboxEvent"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "OutboxEvent_correlationId_idx" ON "OutboxEvent"("correlationId");

-- CreateIndex
CREATE INDEX "SystemEvent_eventType_createdAt_idx" ON "SystemEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "SystemEvent_correlationId_idx" ON "SystemEvent"("correlationId");

-- CreateIndex
CREATE INDEX "Job_status_runAfter_idx" ON "Job"("status", "runAfter");

-- CreateIndex
CREATE INDEX "Job_type_status_idx" ON "Job"("type", "status");

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_resourceId_createdAt_idx" ON "AuditLog"("resourceType", "resourceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorType_actorId_idx" ON "AuditLog"("actorType", "actorId");

-- CreateIndex
CREATE INDEX "AuditLog_correlationId_idx" ON "AuditLog"("correlationId");

-- CreateIndex
CREATE INDEX "Notification_status_scheduledFor_idx" ON "Notification"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "Notification_customerId_createdAt_idx" ON "Notification"("customerId", "createdAt");

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestAccess" ADD CONSTRAINT "GuestAccess_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackagePolicy" ADD CONSTRAINT "PackagePolicy_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FupState" ADD CONSTRAINT "FupState_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouterCapabilityEntry" ADD CONSTRAINT "RouterCapabilityEntry_routerId_fkey" FOREIGN KEY ("routerId") REFERENCES "Router"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetworkPolicy" ADD CONSTRAINT "NetworkPolicy_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetworkOperation" ADD CONSTRAINT "NetworkOperation_routerId_fkey" FOREIGN KEY ("routerId") REFERENCES "Router"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetworkOperation" ADD CONSTRAINT "NetworkOperation_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerSession" ADD CONSTRAINT "CustomerSession_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerSession" ADD CONSTRAINT "CustomerSession_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerSession" ADD CONSTRAINT "CustomerSession_routerId_fkey" FOREIGN KEY ("routerId") REFERENCES "Router"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerSession" ADD CONSTRAINT "CustomerSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CustomerSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

