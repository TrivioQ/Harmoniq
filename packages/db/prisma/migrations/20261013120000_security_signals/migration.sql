-- INST-39 (Phase 9.10): rate-limited requests per workspace, revoked or expired key attempts.
-- AlterTable
ALTER TABLE "SignInEvent" ADD COLUMN     "keyPrefix" TEXT;

-- AlterTable
ALTER TABLE "UsageDaily" ADD COLUMN     "rateLimited" INTEGER NOT NULL DEFAULT 0;

