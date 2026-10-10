-- AlterTable
ALTER TABLE "ModuleHealthEvent" ADD COLUMN     "version" TEXT;

-- CreateTable
CREATE TABLE "ModuleHealthRollup" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "remoteModuleId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "errorCount" INTEGER NOT NULL,
    "p50LoadMs" INTEGER,
    "p95LoadMs" INTEGER,

    CONSTRAINT "ModuleHealthRollup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModuleHealthRollup_workspaceId_hour_idx" ON "ModuleHealthRollup"("workspaceId", "hour");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleHealthRollup_remoteModuleId_environmentId_variant_hou_key" ON "ModuleHealthRollup"("remoteModuleId", "environmentId", "variant", "hour");

-- AddForeignKey
ALTER TABLE "ModuleHealthRollup" ADD CONSTRAINT "ModuleHealthRollup_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleHealthRollup" ADD CONSTRAINT "ModuleHealthRollup_remoteModuleId_fkey" FOREIGN KEY ("remoteModuleId") REFERENCES "RemoteModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleHealthRollup" ADD CONSTRAINT "ModuleHealthRollup_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant isolation, as for ModuleHealthEvent: the owner bypasses RLS (no FORCE), the app
-- role only sees rows of the workspace set in app.current_workspace_id.
ALTER TABLE "ModuleHealthRollup" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_health_rollup ON "ModuleHealthRollup"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

-- Window queries per environment (5-minute health, rollups).
CREATE INDEX "ModuleHealthEvent_environmentId_reportedAt_idx" ON "ModuleHealthEvent"("environmentId", "reportedAt");
