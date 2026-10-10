-- M4.8: instance administration (INST-08..10, 18).
-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedReason" TEXT;

-- CreateTable
CREATE TABLE "InstanceAuditEvent" (
    "id" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstanceAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InstanceAuditEvent_createdAt_idx" ON "InstanceAuditEvent"("createdAt" DESC);


-- Append-only for the runtime role, like AuditEvent.
REVOKE UPDATE, DELETE ON "InstanceAuditEvent" FROM harmoniq_app;
