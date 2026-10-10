-- AlterTable
ALTER TABLE "Environment" ADD COLUMN     "lastPublishError" TEXT,
ADD COLUMN     "lastPublishedAt" TIMESTAMP(3),
ADD COLUMN     "lastPublishedEtag" TEXT;

-- AlterTable
ALTER TABLE "RemoteModule" ADD COLUMN     "specifier" TEXT;

