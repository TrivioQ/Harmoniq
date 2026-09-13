DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'harmoniq_app') THEN
    CREATE ROLE harmoniq_app WITH LOGIN PASSWORD 'password' NOINHERIT;
  END IF;
END
$$;

-- Note: In PostgreSQL, if we use FORCE ROW LEVEL SECURITY, then even the table owner is subject to RLS.
-- This ensures that Prisma operations without `app.current_workspace_id` fail or return nothing, giving defense in depth.

ALTER TABLE "WorkspaceMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceMember" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_member ON "WorkspaceMember"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "HostApp" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HostApp" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_hostapp ON "HostApp"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "RemoteModule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RemoteModule" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_module ON "RemoteModule"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "ModuleVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ModuleVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_version ON "ModuleVersion"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiKey" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_apikey ON "ApiKey"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "WebhookEndpoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEndpoint" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_webhook ON "WebhookEndpoint"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "WebhookDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_delivery ON "WebhookDelivery"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "WebhookDeadLetter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookDeadLetter" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_deadletter ON "WebhookDeadLetter"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_audit ON "AuditEvent"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "ModuleOwnership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ModuleOwnership" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_ownership ON "ModuleOwnership"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "AlertRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AlertRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_alert ON "AlertRule"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "ManifestSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ManifestSnapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_snapshot ON "ManifestSnapshot"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "ModuleHealthEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ModuleHealthEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_health ON "ModuleHealthEvent"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);

ALTER TABLE "ScimAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScimAuditEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation_scim ON "ScimAuditEvent"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE)::TEXT);