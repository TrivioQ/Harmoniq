-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "provider" TEXT,
ADD COLUMN     "ssoCheckedAt" TIMESTAMP(3),
ADD COLUMN     "ssoRefreshToken" TEXT;
