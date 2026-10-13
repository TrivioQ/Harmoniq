-- INST-20, INST-28, INST-38, INST-39 (Phase 9.10): support grants, replica heartbeats, email log, sign-in events.
-- CreateTable
CREATE TABLE "SupportGrant" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "organizationId" TEXT,
    "workspaceId" TEXT,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplicaHeartbeat" (
    "replicaId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "commit" TEXT,
    "hostname" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "configLoadedAt" TIMESTAMP(3),

    CONSTRAINT "ReplicaHeartbeat_pkey" PRIMARY KEY ("replicaId")
);

-- CreateTable
CREATE TABLE "SignInEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "method" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignInEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailDelivery" (
    "id" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportGrant_adminUserId_expiresAt_idx" ON "SupportGrant"("adminUserId", "expiresAt");

-- CreateIndex
CREATE INDEX "SupportGrant_organizationId_idx" ON "SupportGrant"("organizationId");

-- CreateIndex
CREATE INDEX "SupportGrant_workspaceId_idx" ON "SupportGrant"("workspaceId");

-- CreateIndex
CREATE INDEX "SignInEvent_createdAt_idx" ON "SignInEvent"("createdAt");

-- CreateIndex
CREATE INDEX "SignInEvent_email_createdAt_idx" ON "SignInEvent"("email", "createdAt");

-- CreateIndex
CREATE INDEX "SignInEvent_ip_createdAt_idx" ON "SignInEvent"("ip", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_createdAt_idx" ON "EmailDelivery"("createdAt");


-- System tables: instance administration only (no tenant access).
REVOKE ALL ON "SupportGrant", "ReplicaHeartbeat", "SignInEvent", "EmailDelivery" FROM harmoniq_app;
