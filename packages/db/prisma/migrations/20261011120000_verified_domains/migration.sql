-- DOM-01/02: domains verified by DNS for organizations and workspaces (Phase 9.1).
-- CreateTable
CREATE TABLE "VerifiedDomain" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "organizationId" TEXT,
    "workspaceId" TEXT,
    "token" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "verifiedDomain" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "failingSince" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerifiedDomain_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VerifiedDomain_verifiedDomain_key" ON "VerifiedDomain"("verifiedDomain");

-- CreateIndex
CREATE INDEX "VerifiedDomain_domain_idx" ON "VerifiedDomain"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "VerifiedDomain_domain_organizationId_key" ON "VerifiedDomain"("domain", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "VerifiedDomain_domain_workspaceId_key" ON "VerifiedDomain"("domain", "workspaceId");

-- AddForeignKey
ALTER TABLE "VerifiedDomain" ADD CONSTRAINT "VerifiedDomain_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerifiedDomain" ADD CONSTRAINT "VerifiedDomain_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A claim belongs to exactly one organization or one workspace.
ALTER TABLE "VerifiedDomain" ADD CONSTRAINT "VerifiedDomain_one_scope" CHECK (num_nonnulls("workspaceId", "organizationId") = 1);
-- `verifiedDomain` mirrors `domain` exactly while verified.
ALTER TABLE "VerifiedDomain" ADD CONSTRAINT "VerifiedDomain_verified_matches" CHECK ("verifiedDomain" IS NULL OR ("verifiedDomain" = "domain" AND "verifiedAt" IS NOT NULL));

-- Workspace claims are tenant data; organization claims have no workspace, so the tenant
-- role never sees them (like org-scoped SCIM rows). The registry reads both with the
-- system client for SSO discovery.
ALTER TABLE "VerifiedDomain" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_verified_domain ON "VerifiedDomain"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);
