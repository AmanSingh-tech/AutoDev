-- The task-change notice now carries the transaction id, table and row id. Every API process
-- listens, so the bridge uses these to publish each change once (see apps/api/src/events).
CREATE OR REPLACE FUNCTION notify_task_change() RETURNS trigger AS $$
DECLARE
  tid uuid;
BEGIN
  -- to_jsonb, not NEW.task_id: plpgsql checks field names when it compiles, and tasks has no task_id.
  tid := CASE WHEN TG_TABLE_NAME = 'tasks' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'task_id')::uuid END;
  IF tid IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_notify('task_changes', json_build_object(
    'org_id', NEW.org_id,
    'task_id', tid,
    'txid', txid_current()::text,
    'table', TG_TABLE_NAME,
    'row', to_jsonb(NEW)->>'id'
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
