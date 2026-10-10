-- AlterTable
ALTER TABLE "ModuleVersion" ADD COLUMN     "activatedAt" TIMESTAMP(3);

-- Existing active and inactive versions are assumed to have been active once. (Canaries
-- aborted before this migration can't be told apart; the canary feature is newer.)
UPDATE "ModuleVersion" SET "activatedAt" = "deployedAt" WHERE "status" IN ('active', 'inactive');
