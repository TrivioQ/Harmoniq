-- INST-30 (Phase 9.10): email changes started by an instance admin, confirmed by the new address.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "pendingEmail" TEXT,
ADD COLUMN     "pendingEmailExpiresAt" TIMESTAMP(3),
ADD COLUMN     "pendingEmailTokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_pendingEmailTokenHash_key" ON "User"("pendingEmailTokenHash");

