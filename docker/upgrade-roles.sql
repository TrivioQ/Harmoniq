-- One-off upgrade for dev databases created before the owner/app role split.
-- Previously harmoniq_app owned every table, so RLS could not distinguish system and
-- tenant access. Run as the postgres superuser, then `pnpm run db:deploy`:
--
--   docker exec -i harmoniq_postgres psql -U postgres -d harmoniq < docker/upgrade-roles.sql
--
-- Non-destructive: only ownership changes. Grants for harmoniq_app are applied by the
-- next migration (split_owner_and_app_roles).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'harmoniq') THEN
    CREATE ROLE harmoniq WITH LOGIN PASSWORD 'password' CREATEDB;
  END IF;
END
$$;

REASSIGN OWNED BY harmoniq_app TO harmoniq;
ALTER DATABASE harmoniq OWNER TO harmoniq;
ALTER ROLE harmoniq_app NOCREATEDB;
