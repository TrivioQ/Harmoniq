-- TAD-05 (Phase 9.4): org API key rotation with a grace period, as for workspace keys.
-- AlterTable
ALTER TABLE "OrgApiKey" ADD COLUMN     "gracePeriodEnd" TIMESTAMP(3);
