-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'admin', 'developer', 'viewer');

-- CreateEnum
CREATE TYPE "ModuleVersionStatus" AS ENUM ('active', 'inactive', 'canary', 'orphaned');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('user', 'apiKey');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL DEFAULT 90,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMP(3),

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostApp" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HostApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Environment" (
    "id" TEXT NOT NULL,
    "hostAppId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "frozenAt" TIMESTAMP(3),
    "frozenBy" TEXT,
    "freezeReason" TEXT,
    "freezeUntil" TIMESTAMP(3),

    CONSTRAINT "Environment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemoteModule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "hostAppId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemoteModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "remoteModuleId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "integrity" TEXT NOT NULL,
    "storagePath" TEXT,
    "status" "ModuleVersionStatus" NOT NULL,
    "trafficPercent" INTEGER,
    "deployedBy" TEXT NOT NULL,
    "deployedByType" "ActorType" NOT NULL,
    "commitSha" TEXT,
    "metadata" JSONB,
    "dependencies" JSONB,
    "exposes" JSONB,
    "promotedFromId" TEXT,
    "promotedFromEnv" TEXT,
    "rolloutSchedule" JSONB,
    "currentBandIndex" INTEGER,
    "deployedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ModuleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "moduleIds" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "gracePeriodEnd" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "backoffCeilingMs" INTEGER NOT NULL DEFAULT 300000,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "webhookEndpointId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "statusCode" INTEGER,
    "attempt" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDeadLetter" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "webhookEndpointId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "finalStatusCode" INTEGER,
    "finalResponseBody" TEXT,
    "totalAttempts" INTEGER NOT NULL,
    "firstAttemptAt" TIMESTAMP(3) NOT NULL,
    "exhaustedAt" TIMESTAMP(3) NOT NULL,
    "retriedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookDeadLetter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "oauthProvider" TEXT NOT NULL DEFAULT 'github',
    "oauthConfig" JSONB,
    "storageProvider" TEXT NOT NULL DEFAULT 'local',
    "storageConfig" JSONB,
    "logProvider" TEXT NOT NULL DEFAULT 'console',
    "logConfig" JSONB,
    "oidcConfig" JSONB,
    "samlConfig" JSONB,
    "forceSso" BOOLEAN NOT NULL DEFAULT false,
    "trustedDomains" TEXT[],
    "defaultSsoRole" TEXT NOT NULL DEFAULT 'viewer',
    "scimEnabled" BOOLEAN NOT NULL DEFAULT false,
    "scimTokenHash" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'hobby',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleOwnership" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "remoteModuleId" TEXT NOT NULL,
    "workspaceMemberId" TEXT NOT NULL,

    CONSTRAINT "ModuleOwnership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "remoteModuleId" TEXT,
    "environmentId" TEXT,
    "condition" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "action" TEXT NOT NULL,
    "actionConfig" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManifestSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "hostAppId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "manifestJson" JSONB NOT NULL,
    "etag" TEXT NOT NULL,
    "auditEventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ManifestSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleHealthEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "remoteModuleId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "loadMs" INTEGER,
    "errorMessage" TEXT,
    "clientVersion" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModuleHealthEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScimAuditEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "scimUserId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScimAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "HostApp_workspaceId_slug_key" ON "HostApp"("workspaceId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Environment_hostAppId_slug_key" ON "Environment"("hostAppId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "RemoteModule_hostAppId_slug_key" ON "RemoteModule"("hostAppId", "slug");

-- CreateIndex
CREATE INDEX "ModuleVersion_workspaceId_remoteModuleId_environmentId_stat_idx" ON "ModuleVersion"("workspaceId", "remoteModuleId", "environmentId", "status");

-- CreateIndex
CREATE INDEX "ModuleVersion_deletedAt_idx" ON "ModuleVersion"("deletedAt");

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_createdAt_idx" ON "AuditEvent"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_actorId_idx" ON "AuditEvent"("workspaceId", "actorId");

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_action_idx" ON "AuditEvent"("workspaceId", "action");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceConfig_workspaceId_key" ON "WorkspaceConfig"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleOwnership_remoteModuleId_workspaceMemberId_key" ON "ModuleOwnership"("remoteModuleId", "workspaceMemberId");

-- CreateIndex
CREATE INDEX "ManifestSnapshot_workspaceId_hostAppId_environmentId_create_idx" ON "ManifestSnapshot"("workspaceId", "hostAppId", "environmentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ModuleHealthEvent_workspaceId_remoteModuleId_environmentId__idx" ON "ModuleHealthEvent"("workspaceId", "remoteModuleId", "environmentId", "reportedAt");

-- CreateIndex
CREATE INDEX "ScimAuditEvent_workspaceId_createdAt_idx" ON "ScimAuditEvent"("workspaceId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostApp" ADD CONSTRAINT "HostApp_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Environment" ADD CONSTRAINT "Environment_hostAppId_fkey" FOREIGN KEY ("hostAppId") REFERENCES "HostApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemoteModule" ADD CONSTRAINT "RemoteModule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemoteModule" ADD CONSTRAINT "RemoteModule_hostAppId_fkey" FOREIGN KEY ("hostAppId") REFERENCES "HostApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleVersion" ADD CONSTRAINT "ModuleVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleVersion" ADD CONSTRAINT "ModuleVersion_remoteModuleId_fkey" FOREIGN KEY ("remoteModuleId") REFERENCES "RemoteModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleVersion" ADD CONSTRAINT "ModuleVersion_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleVersion" ADD CONSTRAINT "ModuleVersion_promotedFromId_fkey" FOREIGN KEY ("promotedFromId") REFERENCES "ModuleVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhookEndpointId_fkey" FOREIGN KEY ("webhookEndpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDeadLetter" ADD CONSTRAINT "WebhookDeadLetter_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDeadLetter" ADD CONSTRAINT "WebhookDeadLetter_webhookEndpointId_fkey" FOREIGN KEY ("webhookEndpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceConfig" ADD CONSTRAINT "WorkspaceConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleOwnership" ADD CONSTRAINT "ModuleOwnership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleOwnership" ADD CONSTRAINT "ModuleOwnership_remoteModuleId_fkey" FOREIGN KEY ("remoteModuleId") REFERENCES "RemoteModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleOwnership" ADD CONSTRAINT "ModuleOwnership_workspaceMemberId_fkey" FOREIGN KEY ("workspaceMemberId") REFERENCES "WorkspaceMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManifestSnapshot" ADD CONSTRAINT "ManifestSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManifestSnapshot" ADD CONSTRAINT "ManifestSnapshot_hostAppId_fkey" FOREIGN KEY ("hostAppId") REFERENCES "HostApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManifestSnapshot" ADD CONSTRAINT "ManifestSnapshot_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleHealthEvent" ADD CONSTRAINT "ModuleHealthEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleHealthEvent" ADD CONSTRAINT "ModuleHealthEvent_remoteModuleId_fkey" FOREIGN KEY ("remoteModuleId") REFERENCES "RemoteModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleHealthEvent" ADD CONSTRAINT "ModuleHealthEvent_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScimAuditEvent" ADD CONSTRAINT "ScimAuditEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
