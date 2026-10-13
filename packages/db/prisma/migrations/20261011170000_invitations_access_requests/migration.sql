-- PPL-01/02/07 (Phase 9.3): invitations as their own records, and access requests.
-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "organizationId" TEXT,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedBy" TEXT,
    "revokedAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");

-- CreateIndex
CREATE INDEX "Invitation_workspaceId_idx" ON "Invitation"("workspaceId");

-- CreateIndex
CREATE INDEX "Invitation_organizationId_idx" ON "Invitation"("organizationId");

-- CreateIndex
CREATE INDEX "AccessRequest_workspaceId_status_idx" ON "AccessRequest"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "AccessRequest_userId_idx" ON "AccessRequest"("userId");

ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_one_scope" CHECK (num_nonnulls("workspaceId", "organizationId") = 1);

-- RLS like SCIM rows: the workspace (or the current organization's workspaces), or the
-- current organization. Accepting by token resolves the row with the system client.
ALTER TABLE "Invitation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_invitation ON "Invitation"
  USING (
    "workspaceId" = current_setting('app.current_workspace_id', TRUE)
    OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ','))
    OR "organizationId" = current_setting('app.current_org_id', TRUE)
  );

ALTER TABLE "AccessRequest" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_access_request ON "AccessRequest"
  USING (
    "workspaceId" = current_setting('app.current_workspace_id', TRUE)
    OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ','))
  );

-- Data migration: pending workspace memberships (joinedAt IS NULL) become invitations that
-- expire in 7 days. Their token is unknown (never sent), so they are accepted by signing in
-- with the invited email, as before; admins can resend them to get a link.
INSERT INTO "Invitation" ("id", "workspaceId", "email", "role", "tokenHash", "invitedBy", "expiresAt", "createdAt")
SELECT 'mig' || md5(random()::text || wm."id"),
       wm."workspaceId",
       lower(u."email"),
       wm."role"::text,
       md5(random()::text || clock_timestamp()::text || wm."id") || md5(wm."id"),
       'system:migration',
       now() + interval '7 days',
       wm."invitedAt"
  FROM "WorkspaceMember" wm
  JOIN "User" u ON u."id" = wm."userId"
 WHERE wm."joinedAt" IS NULL;

DELETE FROM "WorkspaceMember" WHERE "joinedAt" IS NULL;
