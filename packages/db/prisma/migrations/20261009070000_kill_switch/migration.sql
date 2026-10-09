-- CreateTable
CREATE TABLE "ModuleEnvState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "remoteModuleId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModuleEnvState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModuleEnvState_environmentId_idx" ON "ModuleEnvState"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleEnvState_remoteModuleId_environmentId_key" ON "ModuleEnvState"("remoteModuleId", "environmentId");

-- AddForeignKey
ALTER TABLE "ModuleEnvState" ADD CONSTRAINT "ModuleEnvState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleEnvState" ADD CONSTRAINT "ModuleEnvState_remoteModuleId_fkey" FOREIGN KEY ("remoteModuleId") REFERENCES "RemoteModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleEnvState" ADD CONSTRAINT "ModuleEnvState_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "ModuleEnvState" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_module_env_state ON "ModuleEnvState"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);
