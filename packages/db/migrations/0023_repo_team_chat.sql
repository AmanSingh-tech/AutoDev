-- B-2: the team room per repo, its messages, and the Repo Agent's memory.
CREATE TYPE "public"."channel_author" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "public"."memory_section" AS ENUM('conventions', 'architecture', 'rules', 'fragile_areas');--> statement-breakpoint
CREATE TABLE "channel_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"author" "channel_author" NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "chat_message_status" DEFAULT 'done' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"reply_to_id" uuid,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"commit_sha" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repo_agent_memory" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"section" "memory_section" NOT NULL,
	"content_md" text DEFAULT '' NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_agent_memory_section_uq" UNIQUE("repo_id","section"),
	CONSTRAINT "repo_agent_memory_length" CHECK (char_length("repo_agent_memory"."content_md") <= 8000)
);
--> statement-breakpoint
CREATE TABLE "repo_channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_channels_repo_uq" UNIQUE("repo_id")
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "commit_sha" text;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_channel_id_repo_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."repo_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_reply_to_id_channel_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."channel_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_agent_memory" ADD CONSTRAINT "repo_agent_memory_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_agent_memory" ADD CONSTRAINT "repo_agent_memory_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_agent_memory" ADD CONSTRAINT "repo_agent_memory_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_channels" ADD CONSTRAINT "repo_channels_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_channels" ADD CONSTRAINT "repo_channels_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_messages_channel_idx" ON "channel_messages" USING btree ("channel_id","created_at");
--> statement-breakpoint
-- Inside the org, and only for people with access to the repo (the same rows the API checks).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['repo_channels', 'channel_messages', 'repo_agent_memory'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY repo_readers ON %I USING (org_id = app_org_id() AND EXISTS (SELECT 1 FROM user_repo_access a WHERE a.user_id = app_user_id() AND a.repo_id = %I.repo_id)) WITH CHECK (org_id = app_org_id() AND EXISTS (SELECT 1 FROM user_repo_access a WHERE a.user_id = app_user_id() AND a.repo_id = %I.repo_id))',
      t, t, t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Messages are written by the API and answered by the worker; history is not rewritten or deleted.
REVOKE DELETE ON channel_messages FROM autodev_app;
--> statement-breakpoint
-- Realtime (see packages/events/src/changes.ts).
CREATE TRIGGER chat_messages_row_change AFTER INSERT OR UPDATE ON "chat_messages" FOR EACH ROW EXECUTE FUNCTION notify_row_change('id', 'org_id', 'session_id', 'user_id', 'role', 'status');
--> statement-breakpoint
CREATE TRIGGER channel_messages_row_change AFTER INSERT OR UPDATE ON "channel_messages" FOR EACH ROW EXECUTE FUNCTION notify_row_change('id', 'org_id', 'channel_id', 'repo_id', 'author', 'status');
--> statement-breakpoint
CREATE TRIGGER repo_agent_memory_row_change AFTER INSERT OR UPDATE ON "repo_agent_memory" FOR EACH ROW EXECUTE FUNCTION notify_row_change('id', 'org_id', 'repo_id', 'section');
