-- Phase A-3: RLS for tasks and task_events; task_events is append-only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tasks', 'task_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Tasks are cancelled, never deleted, so their history and usage stay attributable.
REVOKE DELETE ON tasks FROM autodev_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON task_events FROM autodev_app;
--> statement-breakpoint
CREATE FUNCTION task_events_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'task_events is append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events
  FOR EACH ROW EXECUTE FUNCTION task_events_immutable();
--> statement-breakpoint
-- A related task must belong to the same org (RLS can't check a referenced row's org on its own).
CREATE FUNCTION tasks_related_same_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.related_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks WHERE id = NEW.related_task_id AND org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'related task must belong to the same org';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER tasks_related_same_org BEFORE INSERT OR UPDATE OF related_task_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_related_same_org();
