-- AlterTable
ALTER TABLE "Environment" ADD COLUMN     "ephemeral" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "HostApp" ADD COLUMN     "previewUrlTemplate" TEXT;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "allowEphemeralEnvironments" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Environment_ephemeral_expiresAt_idx" ON "Environment"("ephemeral", "expiresAt");
