-- AlterTable
ALTER TABLE "HostApp" ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false;


-- Existing workspaces: the oldest host app becomes the default.
UPDATE "HostApp" h SET "isDefault" = true
WHERE h."id" = (
  SELECT h2."id" FROM "HostApp" h2 WHERE h2."workspaceId" = h."workspaceId"
  ORDER BY h2."createdAt" ASC LIMIT 1
);
