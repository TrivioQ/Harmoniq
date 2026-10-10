-- AlterTable
ALTER TABLE "DeploymentRequest" ADD COLUMN     "bypassed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "method" TEXT NOT NULL DEFAULT 'POST',
ADD COLUMN     "path" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "requestedByType" "ActorType" NOT NULL DEFAULT 'user',
ADD COLUMN     "requiredApprovers" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "result" JSONB,
ADD COLUMN     "resultVersionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentApproval_deploymentRequestId_approverId_key" ON "DeploymentApproval"("deploymentRequestId", "approverId");

-- CreateIndex
CREATE INDEX "DeploymentRequest_status_expiresAt_idx" ON "DeploymentRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "DeploymentRequest_resultVersionId_idx" ON "DeploymentRequest"("resultVersionId");

