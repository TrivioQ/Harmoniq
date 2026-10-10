-- AlterTable
ALTER TABLE "Environment" ADD COLUMN     "freezeOverrideBy" TEXT,
ADD COLUMN     "freezeOverrideReason" TEXT,
ADD COLUMN     "freezeOverrideUntil" TIMESTAMP(3);
