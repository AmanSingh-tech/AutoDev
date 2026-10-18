-- Phase A-6: RLS for pull requests. Written by the worker and webhooks (system role) only.
ALTER TABLE pull_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pull_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON pull_requests USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pull_requests FROM autodev_app;
