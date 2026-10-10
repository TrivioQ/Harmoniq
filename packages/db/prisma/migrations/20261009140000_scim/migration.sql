-- AlterTable
ALTER TABLE "WorkspaceConfig" ADD COLUMN "scimTokenCreatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceConfig_scimTokenHash_key" ON "WorkspaceConfig"("scimTokenHash");

-- CreateTable
CREATE TABLE "ScimUser" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "externalId" TEXT,
    "displayName" TEXT,
    "givenName" TEXT,
    "familyName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScimUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScimGroup" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "externalId" TEXT,
    "memberIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScimGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScimUser_workspaceId_externalId_idx" ON "ScimUser"("workspaceId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ScimUser_workspaceId_userId_key" ON "ScimUser"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ScimUser_workspaceId_userName_key" ON "ScimUser"("workspaceId", "userName");

-- CreateIndex
CREATE UNIQUE INDEX "ScimGroup_workspaceId_displayName_key" ON "ScimGroup"("workspaceId", "displayName");

-- AddForeignKey
ALTER TABLE "ScimUser" ADD CONSTRAINT "ScimUser_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScimUser" ADD CONSTRAINT "ScimUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScimGroup" ADD CONSTRAINT "ScimGroup_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScimUser" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_scim_user ON "ScimUser"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "ScimGroup" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_scim_group ON "ScimGroup"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);
