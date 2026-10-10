-- AlterTable
ALTER TABLE "RemoteModule" ADD COLUMN "orgShared" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "OrgApiKey" ADD COLUMN "prefix" TEXT NOT NULL DEFAULT '',
ADD COLUMN "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "expiresAt" TIMESTAMP(3),
ADD COLUMN "lastUsedAt" TIMESTAMP(3),
ADD COLUMN "createdBy" TEXT;

-- CreateTable
CREATE TABLE "OrganizationAuditEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationAuditEvent_organizationId_createdAt_idx" ON "OrganizationAuditEvent"("organizationId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "OrganizationAuditEvent" ADD CONSTRAINT "OrganizationAuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Append-only, like AuditEvent (AUD-04). Organizations are system tables (no tenant RLS).
REVOKE UPDATE, DELETE ON "OrganizationAuditEvent" FROM harmoniq_app;
