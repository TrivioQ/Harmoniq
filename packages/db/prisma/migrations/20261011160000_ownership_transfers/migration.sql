-- TLC-06 (Phase 9.2): ownership transfers that the recipient accepts.
-- CreateTable
CREATE TABLE "OwnershipTransfer" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "organizationId" TEXT,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnershipTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnershipTransfer_toUserId_idx" ON "OwnershipTransfer"("toUserId");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_workspaceId_idx" ON "OwnershipTransfer"("workspaceId");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_organizationId_idx" ON "OwnershipTransfer"("organizationId");

-- A transfer is a workspace's or an organization's (exactly one).
ALTER TABLE "OwnershipTransfer" ADD CONSTRAINT "OwnershipTransfer_one_scope" CHECK (num_nonnulls("workspaceId", "organizationId") = 1);

-- Same scoping as SCIM rows: the workspace (or the current organization's workspaces), or
-- the current organization. No foreign keys: rows of deleted tenants are harmless and expire.
ALTER TABLE "OwnershipTransfer" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ownership_transfer ON "OwnershipTransfer"
  USING (
    "workspaceId" = current_setting('app.current_workspace_id', TRUE)
    OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ','))
    OR "organizationId" = current_setting('app.current_org_id', TRUE)
  );
