-- POL-01..08 (Phase 9.5): organization-wide policy.
-- CreateTable
CREATE TABLE "OrgPolicy" (
    "organizationId" TEXT NOT NULL,
    "approvalDefaults" JSONB NOT NULL DEFAULT '[]',
    "maxApiKeyDays" INTEGER,
    "allowedKeyScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minRetentionDays" INTEGER,
    "freezeWindows" JSONB NOT NULL DEFAULT '[]',
    "lockSso" BOOLEAN NOT NULL DEFAULT false,
    "sessionMaxHours" INTEGER,
    "idleTimeoutMinutes" INTEGER,
    "ipAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ipAllowlistManifests" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "OrgPolicy_pkey" PRIMARY KEY ("organizationId")
);

-- AddForeignKey
ALTER TABLE "OrgPolicy" ADD CONSTRAINT "OrgPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Readable from the organization's scope and from any of its workspaces (enforcement runs
-- in workspace transactions); written only in the organization's scope.
ALTER TABLE "OrgPolicy" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_policy_read ON "OrgPolicy" FOR SELECT
  USING (
    "organizationId" = current_setting('app.current_org_id', TRUE)
    OR "organizationId" IN (
      SELECT "organizationId" FROM "Workspace"
      WHERE "id" = current_setting('app.current_workspace_id', TRUE)
    )
  );
CREATE POLICY org_policy_write ON "OrgPolicy"
  USING ("organizationId" = current_setting('app.current_org_id', TRUE))
  WITH CHECK ("organizationId" = current_setting('app.current_org_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON "OrgPolicy" TO harmoniq_app;
