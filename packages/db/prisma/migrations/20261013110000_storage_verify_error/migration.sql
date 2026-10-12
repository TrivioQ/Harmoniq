-- INST-27 (Phase 9.10): tenant buckets that fail verification.
-- AlterTable
ALTER TABLE "WorkspaceStorageConfig" ADD COLUMN     "lastVerifyError" TEXT,
ADD COLUMN     "lastVerifyFailedAt" TIMESTAMP(3);

