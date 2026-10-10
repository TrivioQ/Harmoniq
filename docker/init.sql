-- Runs once, as the postgres superuser, when the data volume is first created.
--
-- harmoniq      owns the schema. Runs migrations and backs `systemDb` (tenant resolution,
--               background jobs, instance admin). As owner, it is not subject to RLS.
-- harmoniq_app  runtime role for tenant-scoped queries. Not an owner, so Row-Level
--               Security always applies; it only sees rows for `app.current_workspace_id`.
--
-- Existing dev volumes created before this split: run docker/upgrade-roles.sql once.
CREATE USER harmoniq WITH PASSWORD 'password' CREATEDB;
CREATE USER harmoniq_app WITH PASSWORD 'password';
CREATE DATABASE harmoniq OWNER harmoniq;
