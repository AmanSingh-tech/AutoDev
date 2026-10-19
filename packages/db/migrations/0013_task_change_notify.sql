-- Realtime task updates: every write that the task page or board shows sends a NOTIFY on commit.
-- The payload is only { org_id, task_id }, never content. Subscribers (the API's SSE stream) check
-- org membership before they forward it, and clients refetch what they show.
CREATE OR REPLACE FUNCTION notify_task_change() RETURNS trigger AS $$
DECLARE
  tid uuid;
BEGIN
  -- to_jsonb, not NEW.task_id: plpgsql checks field names when it compiles, and tasks has no task_id.
  tid := CASE WHEN TG_TABLE_NAME = 'tasks' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'task_id')::uuid END;
  IF tid IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_notify('task_changes', json_build_object('org_id', NEW.org_id, 'task_id', tid)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER task_events_notify AFTER INSERT OR UPDATE ON task_events FOR EACH ROW EXECUTE FUNCTION notify_task_change();
--> statement-breakpoint
CREATE TRIGGER tasks_notify AFTER INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION notify_task_change();
--> statement-breakpoint
CREATE TRIGGER agent_runs_notify AFTER INSERT OR UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION notify_task_change();
--> statement-breakpoint
CREATE TRIGGER agent_steps_notify AFTER INSERT OR UPDATE ON agent_steps FOR EACH ROW EXECUTE FUNCTION notify_task_change();
--> statement-breakpoint
CREATE TRIGGER task_documents_notify AFTER INSERT OR UPDATE ON task_documents FOR EACH ROW EXECUTE FUNCTION notify_task_change();
--> statement-breakpoint
CREATE TRIGGER task_questions_notify AFTER INSERT OR UPDATE ON task_questions FOR EACH ROW EXECUTE FUNCTION notify_task_change();
--> statement-breakpoint
CREATE TRIGGER pull_requests_notify AFTER INSERT OR UPDATE ON pull_requests FOR EACH ROW EXECUTE FUNCTION notify_task_change();
--> statement-breakpoint
CREATE TRIGGER builder_jobs_notify AFTER INSERT OR UPDATE ON builder_jobs FOR EACH ROW EXECUTE FUNCTION notify_task_change();
