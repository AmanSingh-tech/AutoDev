-- B-3: repo links (cross-repo sync) and the source of a ported task.
CREATE TABLE "repo_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"source_repo_id" uuid NOT NULL,
	"target_repo_id" uuid NOT NULL,
	"two_way" boolean DEFAULT false NOT NULL,
	"mapping_notes_md" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_links_not_self" CHECK ("repo_links"."source_repo_id" <> "repo_links"."target_repo_id"),
	CONSTRAINT "repo_links_notes_length" CHECK (char_length("repo_links"."mapping_notes_md") <= 8000)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "source_task_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "source_context_md" text;--> statement-breakpoint
ALTER TABLE "repo_links" ADD CONSTRAINT "repo_links_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_links" ADD CONSTRAINT "repo_links_source_repo_id_repos_id_fk" FOREIGN KEY ("source_repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_links" ADD CONSTRAINT "repo_links_target_repo_id_repos_id_fk" FOREIGN KEY ("target_repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_links" ADD CONSTRAINT "repo_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repo_links_pair_uq" ON "repo_links" USING btree (least("source_repo_id", "target_repo_id"),greatest("source_repo_id", "target_repo_id"));--> statement-breakpoint
CREATE INDEX "repo_links_target_idx" ON "repo_links" USING btree ("target_repo_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_source_idx" ON "tasks" USING btree ("source_task_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_not_self_source" CHECK ("tasks"."source_task_id" is distinct from "tasks"."id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_context_length" CHECK ("tasks"."source_context_md" is null or char_length("tasks"."source_context_md") <= 60000);--> statement-breakpoint
-- Read: inside the org, for people who can access either repo. Write: access to both repos. Only
-- admins change links (checked in the API).
ALTER TABLE repo_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE repo_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY repo_readers ON repo_links
  USING (org_id = app_org_id() AND EXISTS (SELECT 1 FROM user_repo_access a WHERE a.user_id = app_user_id() AND a.repo_id IN (repo_links.source_repo_id, repo_links.target_repo_id)))
  WITH CHECK (org_id = app_org_id() AND (SELECT count(*) FROM user_repo_access a WHERE a.user_id = app_user_id() AND a.repo_id IN (repo_links.source_repo_id, repo_links.target_repo_id)) = 2);
