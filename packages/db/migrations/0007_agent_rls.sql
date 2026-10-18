-- Phase A-4: RLS for the agent runtime tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_runs', 'agent_steps', 'task_documents', 'task_questions', 'workspaces', 'workspace_files', 'blobs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Only the agent worker (system role) writes runs, steps, workspaces and blobs. The app role reads
-- runs, steps and the workspace (for the UI) and writes reviews and answers.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON agent_runs, agent_steps, workspaces, workspace_files FROM autodev_app;
--> statement-breakpoint
REVOKE ALL ON blobs FROM autodev_app;
--> statement-breakpoint
REVOKE DELETE ON task_documents, task_questions FROM autodev_app;
--> statement-breakpoint
-- Document content can't be rewritten after the fact; only the review fields change.
CREATE FUNCTION task_documents_content_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_md IS DISTINCT FROM OLD.content_md OR NEW.version <> OLD.version OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'task_documents content is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_documents_content_immutable BEFORE UPDATE ON task_documents
  FOR EACH ROW EXECUTE FUNCTION task_documents_content_immutable();
