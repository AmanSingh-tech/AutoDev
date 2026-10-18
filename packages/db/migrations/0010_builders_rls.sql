-- Phase A-5: RLS for builders. Builder tokens are hashed; the app role can't read the hashes.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builders', 'builder_repo_bindings', 'builder_jobs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE SELECT, INSERT, UPDATE, DELETE ON builders FROM autodev_app;
--> statement-breakpoint
GRANT SELECT (id, org_id, owner_user_id, name, kind, allow_shared, os, arch, cli_version, docker_available,
  max_cpus, max_memory_mb, last_seen_at, revoked_at, created_at, updated_at) ON builders TO autodev_app;
--> statement-breakpoint
-- Jobs are written by the worker and the gateway (system role) only.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON builder_jobs, builder_repo_bindings FROM autodev_app;
