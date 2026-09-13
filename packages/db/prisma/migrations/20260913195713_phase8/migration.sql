-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "organizationId" TEXT;

-- CreateTable
CREATE TABLE "ApprovalPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "requiredApprovers" INTEGER NOT NULL DEFAULT 1,
    "eligibleRoles" TEXT[],
    "requireChangeTicket" BOOLEAN NOT NULL DEFAULT false,
    "ticketUrlPattern" TEXT,
    "expiryHours" INTEGER NOT NULL DEFAULT 24,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "changeTicketId" TEXT,
    "changeTicketUrl" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "bypassJustification" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentApproval" (
    "id" TEXT NOT NULL,
    "deploymentRequestId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'hobby',
    "oidcConfig" JSONB,
    "samlConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgApiKey" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workspaceScope" TEXT[],
    "moduleScope" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "OrgApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstanceConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "InstanceConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstanceAdmin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "InstanceAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceStorageConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "credentialsEncrypted" JSONB NOT NULL,
    "cdnPrefix" TEXT,
    "pathPrefix" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceStorageConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovalPolicy_workspaceId_idx" ON "ApprovalPolicy"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalPolicy_workspaceId_environmentId_key" ON "ApprovalPolicy"("workspaceId", "environmentId");

-- CreateIndex
CREATE INDEX "DeploymentRequest_workspaceId_idx" ON "DeploymentRequest"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "InstanceConfig_key_key" ON "InstanceConfig"("key");

-- CreateIndex
CREATE UNIQUE INDEX "InstanceAdmin_userId_key" ON "InstanceAdmin"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceStorageConfig_workspaceId_key" ON "WorkspaceStorageConfig"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceStorageConfig_workspaceId_idx" ON "WorkspaceStorageConfig"("workspaceId");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalPolicy" ADD CONSTRAINT "ApprovalPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentRequest" ADD CONSTRAINT "DeploymentRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentApproval" ADD CONSTRAINT "DeploymentApproval_deploymentRequestId_fkey" FOREIGN KEY ("deploymentRequestId") REFERENCES "DeploymentRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgApiKey" ADD CONSTRAINT "OrgApiKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstanceAdmin" ADD CONSTRAINT "InstanceAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceStorageConfig" ADD CONSTRAINT "WorkspaceStorageConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApprovalPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApprovalPolicy" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_approval_policy ON "ApprovalPolicy"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "DeploymentRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeploymentRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_deployment_request ON "DeploymentRequest"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "WorkspaceStorageConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceStorageConfig" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_workspace_storage_config ON "WorkspaceStorageConfig"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);
