-- BYOB-02: S3-compatible endpoints for workspace buckets.
-- AlterTable
ALTER TABLE "WorkspaceStorageConfig" ADD COLUMN     "endpoint" TEXT;

