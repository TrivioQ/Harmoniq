-- AlterTable
ALTER TABLE "HostApp" ADD COLUMN     "sharedDependencies" JSONB,
ADD COLUMN     "strictExposes" BOOLEAN NOT NULL DEFAULT false;
