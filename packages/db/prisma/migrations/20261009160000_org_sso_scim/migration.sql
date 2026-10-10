-- ORG-05..07: organization-level SSO and SCIM.
-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "forceSso" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "provisioning" JSONB,
ADD COLUMN     "scimEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scimTokenCreatedAt" TIMESTAMP(3),
ADD COLUMN     "scimTokenHash" TEXT,
ADD COLUMN     "trustedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ScimAuditEvent" ADD COLUMN     "organizationId" TEXT,
ALTER COLUMN "workspaceId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ScimGroup" ADD COLUMN     "organizationId" TEXT,
ALTER COLUMN "workspaceId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ScimUser" ADD COLUMN     "organizationId" TEXT,
ALTER COLUMN "workspaceId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "WorkspaceMember" ADD COLUMN     "orgProvisioned" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_scimTokenHash_key" ON "Organization"("scimTokenHash");

-- CreateIndex
CREATE INDEX "ScimAuditEvent_organizationId_createdAt_idx" ON "ScimAuditEvent"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ScimGroup_organizationId_displayName_key" ON "ScimGroup"("organizationId", "displayName");

-- CreateIndex
CREATE UNIQUE INDEX "ScimUser_organizationId_userId_key" ON "ScimUser"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ScimUser_organizationId_userName_key" ON "ScimUser"("organizationId", "userName");

-- AddForeignKey
ALTER TABLE "ScimUser" ADD CONSTRAINT "ScimUser_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScimGroup" ADD CONSTRAINT "ScimGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScimAuditEvent" ADD CONSTRAINT "ScimAuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A SCIM row belongs to exactly one workspace or one organization. Organization rows
-- have no workspace, so the tenant role (RLS on workspaceId) never sees them; the
-- registry reads them with the system client.
ALTER TABLE "ScimUser" ADD CONSTRAINT "ScimUser_one_scope" CHECK (num_nonnulls("workspaceId", "organizationId") = 1);
ALTER TABLE "ScimGroup" ADD CONSTRAINT "ScimGroup_one_scope" CHECK (num_nonnulls("workspaceId", "organizationId") = 1);
ALTER TABLE "ScimAuditEvent" ADD CONSTRAINT "ScimAuditEvent_one_scope" CHECK (num_nonnulls("workspaceId", "organizationId") = 1);
