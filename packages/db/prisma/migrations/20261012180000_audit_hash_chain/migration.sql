-- AUD-09 (Phase 9.8): tamper-evident audit logs: each row hashed with the previous row of its scope.
-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "chainSeq" BIGINT,
ADD COLUMN     "hash" TEXT,
ADD COLUMN     "prevHash" TEXT;

-- AlterTable
ALTER TABLE "InstanceAuditEvent" ADD COLUMN     "chainSeq" BIGINT,
ADD COLUMN     "hash" TEXT,
ADD COLUMN     "prevHash" TEXT;

-- AlterTable
ALTER TABLE "OrganizationAuditEvent" ADD COLUMN     "chainSeq" BIGINT,
ADD COLUMN     "hash" TEXT,
ADD COLUMN     "prevHash" TEXT;

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_chainSeq_idx" ON "AuditEvent"("workspaceId", "chainSeq");

-- CreateIndex
CREATE INDEX "InstanceAuditEvent_chainSeq_idx" ON "InstanceAuditEvent"("chainSeq");

-- CreateIndex
CREATE INDEX "OrganizationAuditEvent_organizationId_chainSeq_idx" ON "OrganizationAuditEvent"("organizationId", "chainSeq");

-- The hash of a row: sha256 over the previous hash and the row's fields, '|'-separated.
-- `metadata` uses jsonb's canonical text; `createdAt` its epoch milliseconds. Verification
-- (GET …/audit/verify) recomputes it with this same function.
CREATE OR REPLACE FUNCTION harmoniq_audit_hash(
  prev text, id text, scope text, actor_type text, actor_id text, action text,
  resource_type text, resource_id text, metadata jsonb, ip text, created_at timestamp
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    coalesce(prev, ''), id, coalesce(scope, ''), actor_type, actor_id, action,
    resource_type, resource_id, coalesce(metadata::text, ''), coalesce(ip, ''),
    (extract(epoch FROM created_at) * 1000)::bigint::text
  ), 'UTF8')), 'hex')
$$;

-- One chain per scope. The advisory lock serializes inserts of a scope, so concurrent
-- writers can't fork the chain. SECURITY DEFINER: the previous row is read regardless of
-- the caller's RLS context.
CREATE OR REPLACE FUNCTION harmoniq_audit_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  scope text;
  last record;
BEGIN
  -- Stored at millisecond precision: hash what is stored.
  NEW."createdAt" := NEW."createdAt"::timestamp(3);
  IF TG_TABLE_NAME = 'AuditEvent' THEN
    scope := NEW."workspaceId";
    PERFORM pg_advisory_xact_lock(hashtextextended('audit:ws:' || scope, 0));
    SELECT "chainSeq", "hash" INTO last FROM "AuditEvent"
      WHERE "workspaceId" = scope AND "chainSeq" IS NOT NULL
      ORDER BY "chainSeq" DESC LIMIT 1;
  ELSIF TG_TABLE_NAME = 'OrganizationAuditEvent' THEN
    scope := NEW."organizationId";
    PERFORM pg_advisory_xact_lock(hashtextextended('audit:org:' || scope, 0));
    SELECT "chainSeq", "hash" INTO last FROM "OrganizationAuditEvent"
      WHERE "organizationId" = scope AND "chainSeq" IS NOT NULL
      ORDER BY "chainSeq" DESC LIMIT 1;
  ELSE
    scope := '';
    PERFORM pg_advisory_xact_lock(hashtextextended('audit:instance', 0));
    SELECT "chainSeq", "hash" INTO last FROM "InstanceAuditEvent"
      WHERE "chainSeq" IS NOT NULL
      ORDER BY "chainSeq" DESC LIMIT 1;
  END IF;
  NEW."chainSeq" := coalesce(last."chainSeq", 0) + 1;
  NEW."prevHash" := last."hash";
  NEW."hash" := harmoniq_audit_hash(NEW."prevHash", NEW."id", scope, NEW."actorType"::text,
    NEW."actorId", NEW."action", NEW."resourceType", NEW."resourceId", NEW."metadata",
    NEW."ip", NEW."createdAt");
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_event_chain BEFORE INSERT ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION harmoniq_audit_chain();
CREATE TRIGGER organization_audit_event_chain BEFORE INSERT ON "OrganizationAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION harmoniq_audit_chain();
CREATE TRIGGER instance_audit_event_chain BEFORE INSERT ON "InstanceAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION harmoniq_audit_chain();

-- Existing rows join the chain in (createdAt, id) order.
WITH ordered AS (
  SELECT "id", "workspaceId" AS scope,
    row_number() OVER (PARTITION BY "workspaceId" ORDER BY "createdAt", "id") AS seq
  FROM "AuditEvent"
)
UPDATE "AuditEvent" a SET "chainSeq" = o.seq FROM ordered o WHERE a."id" = o."id";
WITH ordered AS (
  SELECT "id", row_number() OVER (PARTITION BY "organizationId" ORDER BY "createdAt", "id") AS seq
  FROM "OrganizationAuditEvent"
)
UPDATE "OrganizationAuditEvent" a SET "chainSeq" = o.seq FROM ordered o WHERE a."id" = o."id";
WITH ordered AS (
  SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS seq FROM "InstanceAuditEvent"
)
UPDATE "InstanceAuditEvent" a SET "chainSeq" = o.seq FROM ordered o WHERE a."id" = o."id";

-- Hashes in chain order (each needs the previous one).
DO $$
DECLARE r record; prev text; cur_scope text := NULL;
BEGIN
  FOR r IN SELECT * FROM "AuditEvent" ORDER BY "workspaceId", "chainSeq" LOOP
    IF cur_scope IS DISTINCT FROM r."workspaceId" THEN prev := NULL; cur_scope := r."workspaceId"; END IF;
    UPDATE "AuditEvent" SET "prevHash" = prev, "hash" = harmoniq_audit_hash(prev, r."id", r."workspaceId",
      r."actorType"::text, r."actorId", r."action", r."resourceType", r."resourceId", r."metadata", r."ip", r."createdAt")
      WHERE "id" = r."id" RETURNING "hash" INTO prev;
  END LOOP;
  prev := NULL; cur_scope := NULL;
  FOR r IN SELECT * FROM "OrganizationAuditEvent" ORDER BY "organizationId", "chainSeq" LOOP
    IF cur_scope IS DISTINCT FROM r."organizationId" THEN prev := NULL; cur_scope := r."organizationId"; END IF;
    UPDATE "OrganizationAuditEvent" SET "prevHash" = prev, "hash" = harmoniq_audit_hash(prev, r."id", r."organizationId",
      r."actorType"::text, r."actorId", r."action", r."resourceType", r."resourceId", r."metadata", r."ip", r."createdAt")
      WHERE "id" = r."id" RETURNING "hash" INTO prev;
  END LOOP;
  prev := NULL;
  FOR r IN SELECT * FROM "InstanceAuditEvent" ORDER BY "chainSeq" LOOP
    UPDATE "InstanceAuditEvent" SET "prevHash" = prev, "hash" = harmoniq_audit_hash(prev, r."id", '',
      r."actorType"::text, r."actorId", r."action", r."resourceType", r."resourceId", r."metadata", r."ip", r."createdAt")
      WHERE "id" = r."id" RETURNING "hash" INTO prev;
  END LOOP;
END $$;
