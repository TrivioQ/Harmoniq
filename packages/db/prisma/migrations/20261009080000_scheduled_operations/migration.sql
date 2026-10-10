-- CreateTable
CREATE TABLE "ScheduledOperation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "module" TEXT,
    "environment" TEXT,
    "description" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdById" TEXT NOT NULL,
    "createdByType" "ActorType" NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledOperation_status_runAt_idx" ON "ScheduledOperation"("status", "runAt");

-- CreateIndex
CREATE INDEX "ScheduledOperation_workspaceId_runAt_idx" ON "ScheduledOperation"("workspaceId", "runAt");

-- AddForeignKey
ALTER TABLE "ScheduledOperation" ADD CONSTRAINT "ScheduledOperation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "ScheduledOperation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_scheduled_operation ON "ScheduledOperation"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);
