-- MT-07/08 (ADR-010): organization-scoped Row-Level Security.
--
-- `withOrg` (packages/db) runs a transaction with two settings:
--   app.current_org_id             the organization
--   app.current_org_workspace_ids  its workspace ids, comma-separated, resolved inside the
--                                  same transaction from "Workspace"."organizationId"
-- Organization tables are visible for the current organization only, and every
-- workspace-scoped table also admits the rows of the organization's own workspaces. Without
-- these settings (workspace transactions, unscoped queries) nothing changes.
-- The schema owner (systemDb) still bypasses RLS: the tables are not FORCEd.

-- 1. Organization tables.
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation_organization ON "Organization"
  USING ("id" = current_setting('app.current_org_id', TRUE));

ALTER TABLE "OrganizationMember" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation_organizationMember ON "OrganizationMember"
  USING ("organizationId" = current_setting('app.current_org_id', TRUE));

ALTER TABLE "OrgApiKey" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation_orgApiKey ON "OrgApiKey"
  USING ("organizationId" = current_setting('app.current_org_id', TRUE));

ALTER TABLE "OrganizationAuditEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation_organizationAuditEvent ON "OrganizationAuditEvent"
  USING ("organizationId" = current_setting('app.current_org_id', TRUE));

-- 2. Workspaces: the current one, and those of the current organization (also used to
--    resolve app.current_org_workspace_ids).
DROP POLICY workspace_isolation_workspace ON "Workspace";
CREATE POLICY workspace_isolation_workspace ON "Workspace"
  USING (
    "id" = current_setting('app.current_workspace_id', TRUE)
    OR "id" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ','))
    OR "organizationId" = current_setting('app.current_org_id', TRUE)
  );

-- 3. Workspace-scoped tables: also the organization's workspaces.
DROP POLICY workspace_isolation_alert ON "AlertRule";
CREATE POLICY workspace_isolation_alert ON "AlertRule"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_apikey ON "ApiKey";
CREATE POLICY workspace_isolation_apikey ON "ApiKey"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_approval_policy ON "ApprovalPolicy";
CREATE POLICY workspace_isolation_approval_policy ON "ApprovalPolicy"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_audit ON "AuditEvent";
CREATE POLICY workspace_isolation_audit ON "AuditEvent"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_deployment_request ON "DeploymentRequest";
CREATE POLICY workspace_isolation_deployment_request ON "DeploymentRequest"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_hostapp ON "HostApp";
CREATE POLICY workspace_isolation_hostapp ON "HostApp"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_snapshot ON "ManifestSnapshot";
CREATE POLICY workspace_isolation_snapshot ON "ManifestSnapshot"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_module_env_state ON "ModuleEnvState";
CREATE POLICY workspace_isolation_module_env_state ON "ModuleEnvState"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_health ON "ModuleHealthEvent";
CREATE POLICY workspace_isolation_health ON "ModuleHealthEvent"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_health_rollup ON "ModuleHealthRollup";
CREATE POLICY workspace_isolation_health_rollup ON "ModuleHealthRollup"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_ownership ON "ModuleOwnership";
CREATE POLICY workspace_isolation_ownership ON "ModuleOwnership"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_version ON "ModuleVersion";
CREATE POLICY workspace_isolation_version ON "ModuleVersion"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_module ON "RemoteModule";
CREATE POLICY workspace_isolation_module ON "RemoteModule"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_scheduled_operation ON "ScheduledOperation";
CREATE POLICY workspace_isolation_scheduled_operation ON "ScheduledOperation"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_deadletter ON "WebhookDeadLetter";
CREATE POLICY workspace_isolation_deadletter ON "WebhookDeadLetter"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_delivery ON "WebhookDelivery";
CREATE POLICY workspace_isolation_delivery ON "WebhookDelivery"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_webhook ON "WebhookEndpoint";
CREATE POLICY workspace_isolation_webhook ON "WebhookEndpoint"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_workspace_config ON "WorkspaceConfig";
CREATE POLICY workspace_isolation_workspace_config ON "WorkspaceConfig"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_member ON "WorkspaceMember";
CREATE POLICY workspace_isolation_member ON "WorkspaceMember"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

DROP POLICY workspace_isolation_workspace_storage_config ON "WorkspaceStorageConfig";
CREATE POLICY workspace_isolation_workspace_storage_config ON "WorkspaceStorageConfig"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')));

-- 4. Rows that belong to a workspace or to an organization (exactly one).
DROP POLICY workspace_isolation_scim ON "ScimAuditEvent";
CREATE POLICY workspace_isolation_scim ON "ScimAuditEvent"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')) OR "organizationId" = current_setting('app.current_org_id', TRUE));

DROP POLICY workspace_isolation_scim_group ON "ScimGroup";
CREATE POLICY workspace_isolation_scim_group ON "ScimGroup"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')) OR "organizationId" = current_setting('app.current_org_id', TRUE));

DROP POLICY workspace_isolation_scim_user ON "ScimUser";
CREATE POLICY workspace_isolation_scim_user ON "ScimUser"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')) OR "organizationId" = current_setting('app.current_org_id', TRUE));

DROP POLICY workspace_isolation_verified_domain ON "VerifiedDomain";
CREATE POLICY workspace_isolation_verified_domain ON "VerifiedDomain"
  USING ("workspaceId" = current_setting('app.current_workspace_id', TRUE) OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ',')) OR "organizationId" = current_setting('app.current_org_id', TRUE));
