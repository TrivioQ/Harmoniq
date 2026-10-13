-- AUD-05 (gap analysis P0-2): deleting a workspace no longer deletes its audit trail.
-- Rows keep their workspaceId (RLS still applies) and are removed by GC after
-- HARMONIQ_AUDIT_RETENTION_DAYS once the workspace is gone.
-- DropForeignKey
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "ScimAuditEvent" DROP CONSTRAINT "ScimAuditEvent_workspaceId_fkey";

