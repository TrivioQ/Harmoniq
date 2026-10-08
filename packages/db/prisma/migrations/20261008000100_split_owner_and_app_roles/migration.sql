-- Split schema ownership from runtime tenant access (see docker/init.sql).
--
-- The schema owner (harmoniq, runs this migration) bypasses RLS because FORCE is removed.
-- harmoniq_app gets DML grants only, so RLS always applies to it and queries without
-- `app.current_workspace_id` see nothing.

-- 1. Owner bypasses RLS; tenant role is always subject to it.
ALTER TABLE "WorkspaceMember" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "HostApp" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "RemoteModule" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ModuleVersion" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ApiKey" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEndpoint" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "WebhookDelivery" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "WebhookDeadLetter" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ModuleOwnership" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "AlertRule" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ManifestSnapshot" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ModuleHealthEvent" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScimAuditEvent" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ApprovalPolicy" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "DeploymentRequest" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceStorageConfig" NO FORCE ROW LEVEL SECURITY;

-- 2. Tenant tables that had no policy yet.
ALTER TABLE "Workspace" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_workspace ON "Workspace"
  USING ("id" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "WorkspaceConfig" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_workspace_config ON "WorkspaceConfig"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

-- Environment and DeploymentApproval have no workspaceId; scope them through their
-- parent row, which is itself RLS-protected for harmoniq_app.
ALTER TABLE "Environment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_environment ON "Environment"
  USING (EXISTS (SELECT 1 FROM "HostApp" h WHERE h."id" = "Environment"."hostAppId"));

ALTER TABLE "DeploymentApproval" ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_deployment_approval ON "DeploymentApproval"
  USING (EXISTS (
    SELECT 1 FROM "DeploymentRequest" r WHERE r."id" = "DeploymentApproval"."deploymentRequestId"
  ));

-- 3. Runtime grants for the tenant role (current and future tables).
GRANT USAGE ON SCHEMA public TO harmoniq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO harmoniq_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO harmoniq_app;
REVOKE ALL ON "_prisma_migrations" FROM harmoniq_app;

-- 4. Audit log is append-only for the runtime role (AUD-04). Workspace deletion still
--    cascades because referential actions run with the table owner's privileges.
REVOKE UPDATE, DELETE ON "AuditEvent" FROM harmoniq_app;
