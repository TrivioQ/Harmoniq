-- TLC-02/03/04, AUD-05 (Phase 9.2): soft-deleted workspaces and organizations with a
-- purge date, organization suspension, and audit trails that outlive their organization.
-- DropForeignKey
ALTER TABLE "OrganizationAuditEvent" DROP CONSTRAINT "OrganizationAuditEvent_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "ScimAuditEvent" DROP CONSTRAINT "ScimAuditEvent_organizationId_fkey";

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "purgeAfter" TIMESTAMP(3),
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedReason" TEXT;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "purgeAfter" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Organization_purgeAfter_idx" ON "Organization"("purgeAfter");

-- CreateIndex
CREATE INDEX "Workspace_purgeAfter_idx" ON "Workspace"("purgeAfter");
