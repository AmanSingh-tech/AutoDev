CREATE TYPE "public"."pr_created_by" AS ENUM('user', 'agent_on_completion', 'stale_job');--> statement-breakpoint
CREATE TYPE "public"."pr_state" AS ENUM('open', 'closed', 'merged');--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"github_pr_id" bigint NOT NULL,
	"number" integer NOT NULL,
	"url" text NOT NULL,
	"head_branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"head_sha" text,
	"state" "pr_state" DEFAULT 'open' NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"created_by" "pr_created_by" NOT NULL,
	"created_by_user_id" uuid,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_requests_repo_number_uq" UNIQUE("repo_id","number")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "change_notes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "last_pushed_sha" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "last_pushed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "stale_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pull_requests_task_idx" ON "pull_requests" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "pull_requests_gh_idx" ON "pull_requests" USING btree ("github_pr_id");