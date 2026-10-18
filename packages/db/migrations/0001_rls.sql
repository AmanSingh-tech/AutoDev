-- Row-level security for Section A, phase A-1.
-- Request paths connect as autodev_app and set app.org_id / app.user_id per transaction (withRls).
-- An unset setting reads as NULL, so a missing context returns no rows (fails closed).

CREATE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

-- github_tokens: only the system role (token vault) may touch it.
REVOKE ALL ON github_tokens FROM autodev_app;
--> statement-breakpoint

-- users: global table. The app role can read yourself and members of the current org. Writes go through the system role at login.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE INSERT, DELETE ON users FROM autodev_app;
--> statement-breakpoint
CREATE POLICY users_visible ON users FOR SELECT USING (
  id = app_user_id()
  OR id IN (SELECT user_id FROM org_members WHERE org_id = app_org_id())
);
--> statement-breakpoint
CREATE POLICY users_self_update ON users FOR UPDATE USING (id = app_user_id()) WITH CHECK (id = app_user_id());
--> statement-breakpoint

-- orgs: created and deleted only by the system role (installation flow).
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE orgs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE INSERT, DELETE ON orgs FROM autodev_app;
--> statement-breakpoint
CREATE POLICY orgs_current ON orgs USING (id = app_org_id()) WITH CHECK (id = app_org_id());
--> statement-breakpoint
CREATE POLICY orgs_my_memberships ON orgs FOR SELECT USING (
  id IN (SELECT org_id FROM org_members WHERE user_id = app_user_id() AND status = 'active')
);
--> statement-breakpoint

-- org_members: the standard tenant policy, plus users can see their own memberships in every org.
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE org_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON org_members USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
CREATE POLICY members_self_read ON org_members FOR SELECT USING (user_id = app_user_id());
--> statement-breakpoint

-- Standard tenant tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['teams', 'team_members', 'installations', 'repos', 'user_repo_access', 'repo_policies']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- notifications: you read and update only your own, but you may create them for anyone in the org.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notifications_own ON notifications
  USING (org_id = app_org_id() AND user_id = app_user_id())
  WITH CHECK (org_id = app_org_id());
--> statement-breakpoint

-- audit_log: append-only for every role.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM autodev_app;
--> statement-breakpoint
CREATE POLICY audit_read ON audit_log FOR SELECT USING (org_id = app_org_id());
--> statement-breakpoint
CREATE POLICY audit_append ON audit_log FOR INSERT WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_mutation BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
