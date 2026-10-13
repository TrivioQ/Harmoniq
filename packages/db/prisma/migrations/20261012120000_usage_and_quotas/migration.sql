-- USG-01/02, PLN-06 (Phase 9.6): daily usage, bundle sizes, plan overrides and trials.
-- AlterTable
ALTER TABLE "ModuleVersion" ADD COLUMN     "sizeBytes" BIGINT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "basePlan" TEXT,
ADD COLUMN     "planExpiresAt" TIMESTAMP(3),
ADD COLUMN     "planOverrides" JSONB;

-- AlterTable
ALTER TABLE "WorkspaceConfig" ADD COLUMN     "basePlan" TEXT,
ADD COLUMN     "planExpiresAt" TIMESTAMP(3),
ADD COLUMN     "planOverrides" JSONB;

-- CreateTable
CREATE TABLE "UsageDaily" (
    "workspaceId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "manifestRequests" BIGINT NOT NULL DEFAULT 0,
    "deploys" INTEGER NOT NULL DEFAULT 0,
    "healthEvents" INTEGER NOT NULL DEFAULT 0,
    "storageBytes" BIGINT NOT NULL DEFAULT 0,
    "members" INTEGER NOT NULL DEFAULT 0,
    "apiKeys" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UsageDaily_pkey" PRIMARY KEY ("workspaceId","day")
);

-- CreateIndex
CREATE INDEX "UsageDaily_day_idx" ON "UsageDaily"("day");

-- Like other workspace rows: the workspace, or the current organization's workspaces.
-- No foreign key: usage history outlives nothing it needs (GC keeps 13 months).
ALTER TABLE "UsageDaily" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_usage_daily ON "UsageDaily"
  USING (
    "workspaceId" = current_setting('app.current_workspace_id', TRUE)
    OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ','))
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON "UsageDaily" TO harmoniq_app;
