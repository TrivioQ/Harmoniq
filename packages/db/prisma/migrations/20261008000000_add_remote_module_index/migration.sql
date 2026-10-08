-- Originally timestamped before `init`, which broke `migrate deploy` on fresh databases.
-- IF NOT EXISTS keeps it a no-op where the index was already created.
CREATE INDEX IF NOT EXISTS "RemoteModule_workspaceId_slug_idx" ON "RemoteModule"("workspaceId", "slug");
