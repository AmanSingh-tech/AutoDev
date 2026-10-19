-- R-3: one generic change notice for every table that feeds web events. Each trigger names the
-- columns its events need; the notice carries only those (Postgres caps a notice at 8000 bytes).
-- apps/api maps notices to catalogue events (packages/events/src/changes.ts). Replaces 0013/0019.
CREATE OR REPLACE FUNCTION notify_row_change() RETURNS trigger AS $$
DECLARE
  newrow jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  oldrow jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  n jsonb := NULL;
  o jsonb := NULL;
  k text;
BEGIN
  IF newrow IS NOT NULL THEN n := '{}'::jsonb; END IF;
  IF oldrow IS NOT NULL THEN o := '{}'::jsonb; END IF;
  FOREACH k IN ARRAY TG_ARGV LOOP
    IF newrow IS NOT NULL THEN n := n || jsonb_build_object(k, newrow->k); END IF;
    IF oldrow IS NOT NULL THEN o := o || jsonb_build_object(k, oldrow->k); END IF;
  END LOOP;
  PERFORM pg_notify('row_changes', jsonb_build_object(
    't', TG_TABLE_NAME, 'op', TG_OP, 'txid', txid_current()::text, 'new', n, 'old', o
  )::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_events_notify ON "task_events";
--> statement-breakpoint
DROP TRIGGER IF EXISTS tasks_notify ON "tasks";
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_runs_notify ON "agent_runs";
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_steps_notify ON "agent_steps";
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_documents_notify ON "task_documents";
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_questions_notify ON "task_questions";
--> statement-breakpoint
DROP TRIGGER IF EXISTS pull_requests_notify ON "pull_requests";
--> statement-breakpoint
DROP TRIGGER IF EXISTS builder_jobs_notify ON "builder_jobs";
--> statement-breakpoint
DROP FUNCTION IF EXISTS notify_task_change();
--> statement-breakpoint
CREATE TRIGGER tasks_row_change AFTER INSERT OR UPDATE OR DELETE ON "tasks" FOR EACH ROW EXECUTE FUNCTION notify_row_change('id', 'org_id', 'repo_id', 'key', 'status', 'last_pushed_sha', 'work_branch');
--> statement-breakpoint
CREATE TRIGGER agent_steps_row_change AFTER INSERT ON "agent_steps" FOR EACH ROW EXECUTE FUNCTION notify_row_change('id', 'org_id', 'task_id', 'agent_run_id', 'kind', 'tool_name');
--> statement-breakpoint
CREATE TRIGGER task_questions_row_change AFTER INSERT OR UPDATE ON "task_questions" FOR EACH ROW EXECUTE FUNCTION notify_row_change('id', 'org_id', 'task_id', 'kind', 'answered_at', 'approved');
--> statement-breakpoint
CREATE TRIGGER task_documents_row_change AFTER INSERT OR UPDATE ON "task_documents" FOR EACH ROW EXECUTE FUNCTION notify_row_change('id', 'org_id', 'task_id', 'kind', 'version', 'status');
--> statement-breakpoint
CREATE TRIGGER builder_jobs_row_change AFTER INSERT OR UPDATE ON "builder_jobs" FOR EACH ROW EXECUTE FUNCTION notify_row_change('id', 'org_id', 'task_id', 'status', 'consent', 'exit_code', 'offline_notified_at');
--> statement-breakpoint
CREATE TRIGGER pull_requests_row_change AFTER INSERT OR UPDATE ON "pull_requests" FOR EACH ROW EXECUTE FUNCTION notify_row_change('id', 'org_id', 'task_id', 'number', 'url', 'state', 'head_sha');
--> statement-breakpoint
CREATE TRIGGER agent_runs_row_change AFTER UPDATE ON "agent_runs" FOR EACH ROW EXECUTE FUNCTION notify_row_change('id', 'org_id', 'task_id', 'status');
--> statement-breakpoint
CREATE TRIGGER token_usage_row_change AFTER INSERT ON "token_usage" FOR EACH ROW EXECUTE FUNCTION notify_row_change('id', 'org_id', 'task_id', 'input_tokens', 'output_tokens', 'cost_usd');
--> statement-breakpoint
CREATE TRIGGER notifications_row_change AFTER INSERT ON "notifications" FOR EACH ROW EXECUTE FUNCTION notify_row_change('id', 'org_id', 'user_id', 'type', 'title', 'payload');
--> statement-breakpoint
CREATE TRIGGER builders_row_change AFTER INSERT OR UPDATE ON "builders" FOR EACH ROW EXECUTE FUNCTION notify_row_change('id', 'org_id', 'owner_user_id', 'revoked_at');
--> statement-breakpoint
CREATE TRIGGER user_repo_access_row_change AFTER INSERT OR UPDATE OR DELETE ON "user_repo_access" FOR EACH ROW EXECUTE FUNCTION notify_row_change('org_id', 'user_id');
--> statement-breakpoint
CREATE TRIGGER llm_credentials_row_change AFTER INSERT OR UPDATE ON "llm_credentials" FOR EACH ROW EXECUTE FUNCTION notify_row_change('id', 'org_id', 'status', 'scope');
--> statement-breakpoint
CREATE TRIGGER installations_row_change AFTER INSERT OR UPDATE ON "installations" FOR EACH ROW EXECUTE FUNCTION notify_row_change('id', 'org_id');
--> statement-breakpoint
CREATE TRIGGER org_members_row_change AFTER INSERT OR UPDATE ON "org_members" FOR EACH ROW EXECUTE FUNCTION notify_row_change('org_id', 'user_id', 'status');
