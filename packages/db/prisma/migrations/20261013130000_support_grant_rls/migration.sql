-- SupportGrant is already revoked from the tenant role; RLS keeps it scoped like every other
-- table with a workspaceId or organizationId, should a grant ever be added.
ALTER TABLE "SupportGrant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_support_grant ON "SupportGrant"
  USING (
    "workspaceId" = current_setting('app.current_workspace_id', TRUE)
    OR "workspaceId" = ANY (string_to_array(current_setting('app.current_org_workspace_ids', TRUE), ','))
    OR "organizationId" = current_setting('app.current_org_id', TRUE)
  );
