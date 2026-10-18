CREATE TYPE "public"."branch_mode" AS ENUM('new', 'existing');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('draft', 'queued', 'planning', 'awaiting_plan_approval', 'designing', 'awaiting_lld_approval', 'coding', 'waiting_for_builder', 'testing', 'fixing', 'needs_input', 'blocked_on_key', 'pushed', 'pr_open', 'resolved', 'rejected', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"type" text NOT NULL,
	"from_status" "task_status",
	"to_status" "task_status",
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description_md" text DEFAULT '' NOT NULL,
	"acceptance_criteria_md" text DEFAULT '' NOT NULL,
	"priority" "task_priority" DEFAULT 'medium' NOT NULL,
	"status" "task_status" DEFAULT 'draft' NOT NULL,
	"mode" "task_mode" NOT NULL,
	"scope_path" text,
	"branch_mode" "branch_mode" NOT NULL,
	"target_branch" text,
	"work_branch" text NOT NULL,
	"base_sha" text,
	"related_task_id" uuid,
	"extra_context" text,
	"create_pr_on_completion" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"owner_id" uuid NOT NULL,
	"summary_md" text,
	"token_cap_override" bigint,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_org_number_uq" UNIQUE("org_id","number"),
	CONSTRAINT "tasks_org_key_uq" UNIQUE("org_id","key"),
	CONSTRAINT "tasks_existing_needs_target" CHECK (("tasks"."branch_mode" = 'existing') = ("tasks"."target_branch" is not null)),
	CONSTRAINT "tasks_title_length" CHECK (char_length("tasks"."title") between 1 and 200),
	CONSTRAINT "tasks_scope_path_relative" CHECK ("tasks"."scope_path" is null or ("tasks"."scope_path" !~ '(^/|\.\.)')),
	CONSTRAINT "tasks_not_self_related" CHECK ("tasks"."related_task_id" is distinct from "tasks"."id")
);
--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_related_task_id_tasks_id_fk" FOREIGN KEY ("related_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_events_task_idx" ON "task_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_board_idx" ON "tasks" USING btree ("org_id","repo_id","status");--> statement-breakpoint
CREATE INDEX "tasks_owner_idx" ON "tasks" USING btree ("org_id","owner_id");