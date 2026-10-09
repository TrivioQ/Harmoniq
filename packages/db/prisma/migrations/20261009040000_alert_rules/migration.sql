-- AlterEnum
ALTER TYPE "ActorType" ADD VALUE 'system';

-- AlterTable
ALTER TABLE "AlertRule" ADD COLUMN     "cooldownMinutes" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastEvaluatedAt" TIMESTAMP(3),
ADD COLUMN     "lastTriggeredAt" TIMESTAMP(3),
ADD COLUMN     "lastValue" DOUBLE PRECISION,
ADD COLUMN     "minSamples" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "state" TEXT NOT NULL DEFAULT 'ok',
ADD COLUMN     "windowMinutes" INTEGER NOT NULL DEFAULT 5;

-- CreateIndex
CREATE INDEX "AlertRule_enabled_idx" ON "AlertRule"("enabled");

-- Rules pointing at deleted modules or environments can't satisfy the new foreign keys
-- (the table was unused until now).
DELETE FROM "AlertRule" r
 WHERE (r."remoteModuleId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "RemoteModule" m WHERE m."id" = r."remoteModuleId"))
    OR (r."environmentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Environment" e WHERE e."id" = r."environmentId"));

-- AddForeignKey
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_remoteModuleId_fkey" FOREIGN KEY ("remoteModuleId") REFERENCES "RemoteModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

