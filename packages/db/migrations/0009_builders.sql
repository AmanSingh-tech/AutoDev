CREATE TYPE "public"."builder_job_status" AS ENUM('queued', 'offered', 'running', 'passed', 'failed', 'timed_out', 'error', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."builder_kind" AS ENUM('personal', 'team');--> statement-breakpoint
CREATE TYPE "public"."job_consent" AS ENUM('not_needed', 'pending', 'granted', 'denied');--> statement-breakpoint
CREATE TABLE "builder_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"repo_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"builder_id" uuid,
	"base_sha" text NOT NULL,
	"workspace_revision" integer NOT NULL,
	"patch_key" text NOT NULL,
	"patch_sha256" text NOT NULL,
	"config_snapshot" jsonb,
	"config_error" text,
	"config_changed" boolean DEFAULT false NOT NULL,
	"consent" "job_consent" DEFAULT 'not_needed' NOT NULL,
	"docker" boolean DEFAULT true NOT NULL,
	"final" boolean DEFAULT false NOT NULL,
	"fix_cycle" integer DEFAULT 0 NOT NULL,
	"status" "builder_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"exit_code" integer,
	"failed_step" text,
	"failed_tests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duration_ms" integer,
	"log_tail" text,
	"log_key" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"offered_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"offline_notified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builder_repo_bindings" (
	"builder_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"local_path" text,
	"first_run_confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builder_repo_bindings_builder_id_repo_id_pk" PRIMARY KEY("builder_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "builders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "builder_kind" DEFAULT 'personal' NOT NULL,
	"allow_shared" boolean DEFAULT false NOT NULL,
	"token_hash" text NOT NULL,
	"os" text,
	"arch" text,
	"cli_version" text,
	"docker_available" boolean DEFAULT false NOT NULL,
	"max_cpus" integer DEFAULT 2 NOT NULL,
	"max_memory_mb" integer DEFAULT 4096 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD CONSTRAINT "builder_jobs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD CONSTRAINT "builder_jobs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD CONSTRAINT "builder_jobs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD CONSTRAINT "builder_jobs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD CONSTRAINT "builder_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD CONSTRAINT "builder_jobs_builder_id_builders_id_fk" FOREIGN KEY ("builder_id") REFERENCES "public"."builders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_repo_bindings" ADD CONSTRAINT "builder_repo_bindings_builder_id_builders_id_fk" FOREIGN KEY ("builder_id") REFERENCES "public"."builders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_repo_bindings" ADD CONSTRAINT "builder_repo_bindings_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_repo_bindings" ADD CONSTRAINT "builder_repo_bindings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_repo_bindings" ADD CONSTRAINT "builder_repo_bindings_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builders" ADD CONSTRAINT "builders_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builders" ADD CONSTRAINT "builders_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "builder_jobs_task_idx" ON "builder_jobs" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "builder_jobs_queue_idx" ON "builder_jobs" USING btree ("org_id","status") WHERE "builder_jobs"."status" in ('queued', 'offered', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "builders_token_hash_uq" ON "builders" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "builders_org_owner_idx" ON "builders" USING btree ("org_id","owner_user_id");