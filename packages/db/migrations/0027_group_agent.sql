-- B-5: Group Agent policies, findings, recommendations and runs.
CREATE TYPE "public"."finding_kind" AS ENUM('vulnerable_dependency', 'outdated_dependency', 'failing_test', 'flaky_test', 'repeated_failure', 'linked_repo_drift', 'unusual_spend', 'stuck_task');--> statement-breakpoint
CREATE TYPE "public"."finding_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."group_agent_run_kind" AS ENUM('scan', 'digest');--> statement-breakpoint
CREATE TYPE "public"."recommendation_status" AS ENUM('open', 'dismissed', 'task_created', 'pr_opened', 'resolved');--> statement-breakpoint
CREATE TABLE "agent_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"monthly_budget_usd" numeric(12, 2),
	"weekly_pr_cap" integer DEFAULT 5 NOT NULL,
	"safety_level" integer DEFAULT 2 NOT NULL,
	"maintainer_user_id" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_policies_target_uq" UNIQUE NULLS NOT DISTINCT("org_id","repo_id"),
	CONSTRAINT "agent_policies_safety_level" CHECK ("agent_policies"."safety_level" between 1 and 3),
	CONSTRAINT "agent_policies_pr_cap" CHECK ("agent_policies"."weekly_pr_cap" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "group_agent_findings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid,
	"kind" "finding_kind" NOT NULL,
	"severity" "finding_severity" NOT NULL,
	"fingerprint" text NOT NULL,
	"title" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"last_run_id" uuid,
	CONSTRAINT "group_agent_findings_fingerprint_uq" UNIQUE("org_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "group_agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "group_agent_run_kind" NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "group_agent_runs_status" CHECK ("group_agent_runs"."status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"repo_id" uuid,
	"status" "recommendation_status" DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"body_md" text NOT NULL,
	"fix_kind" text NOT NULL,
	"task_id" uuid,
	"dismissed_by" uuid,
	"dismissed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendations_finding_uq" UNIQUE("finding_id"),
	CONSTRAINT "recommendations_fix_kind" CHECK ("recommendations"."fix_kind" in ('dependency_bump', 'lint_fix', 'task', 'investigate'))
);
--> statement-breakpoint
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_maintainer_user_id_users_id_fk" FOREIGN KEY ("maintainer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_agent_findings" ADD CONSTRAINT "group_agent_findings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_agent_findings" ADD CONSTRAINT "group_agent_findings_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_agent_runs" ADD CONSTRAINT "group_agent_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_finding_id_group_agent_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."group_agent_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_agent_findings_open_idx" ON "group_agent_findings" USING btree ("org_id","repo_id","resolved_at");--> statement-breakpoint
CREATE INDEX "group_agent_runs_org_idx" ON "group_agent_runs" USING btree ("org_id","kind","started_at");--> statement-breakpoint
CREATE INDEX "recommendations_org_status_idx" ON "recommendations" USING btree ("org_id","status");
--> statement-breakpoint
-- Inside the org. Findings and runs are written by the worker only; the API changes policies
-- (admins) and a recommendation's status (dismiss, task created), never creates or deletes them.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_policies', 'group_agent_findings', 'recommendations', 'group_agent_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON group_agent_findings, group_agent_runs FROM autodev_app;
--> statement-breakpoint
REVOKE INSERT, DELETE, TRUNCATE ON recommendations FROM autodev_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON agent_policies FROM autodev_app;
