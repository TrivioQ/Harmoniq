-- INST-31..35 (Phase 9.9): admin roles and invitations, re-authentication, instance keys, settings versions.
-- AlterTable
ALTER TABLE "InstanceAdmin" ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'instance_owner';

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "reauthAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "InstanceAdminInvitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstanceAdminInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstanceApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "InstanceApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstanceConfigVersion" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'save',

    CONSTRAINT "InstanceConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InstanceAdminInvitation_email_idx" ON "InstanceAdminInvitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "InstanceConfigVersion_key_version_key" ON "InstanceConfigVersion"("key", "version");

-- System tables: instance administration only (no tenant access).
REVOKE ALL ON "InstanceAdminInvitation", "InstanceApiKey", "InstanceConfigVersion" FROM harmoniq_app;
