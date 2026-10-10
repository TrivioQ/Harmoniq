-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "createdByKeyId" TEXT,
ALTER COLUMN "createdBy" DROP NOT NULL;

