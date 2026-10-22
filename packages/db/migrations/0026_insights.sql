-- B-4: daily metrics rollups, leaderboard snapshots and team leads.
CREATE TYPE "public"."leaderboard_period" AS ENUM('week', 'month', 'quarter');--> statement-breakpoint
CREATE TYPE "public"."leaderboard_scope" AS ENUM('org', 'team', 'repo');--> statement-breakpoint
CREATE TABLE "leaderboard_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"period" "leaderboard_period" NOT NULL,
	"period_start" date NOT NULL,
	"scope" "leaderboard_scope" NOT NULL,
	"scope_id" uuid,
	"user_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"impact_score" numeric(12, 4) NOT NULL,
	"prs_merged" integer NOT NULL,
	"approval_rate" numeric(5, 4),
	"cost_usd" numeric(14, 6) NOT NULL,
	"cost_per_pr_usd" numeric(14, 6),
	"tokens" bigint NOT NULL,
	"badges" text[] DEFAULT '{}' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leaderboard_snapshots_uq" UNIQUE NULLS NOT DISTINCT("org_id","period","period_start","scope","scope_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "user_metrics_daily" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"day" date NOT NULL,
	"user_id" uuid,
	"repo_id" uuid,
	"cost_usd" numeric(14, 6) DEFAULT '0' NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"llm_calls" integer DEFAULT 0 NOT NULL,
	"tasks_created" integer DEFAULT 0 NOT NULL,
	"tasks_resolved" integer DEFAULT 0 NOT NULL,
	"prs_merged" integer DEFAULT 0 NOT NULL,
	"docs_reviewed" integer DEFAULT 0 NOT NULL,
	"docs_first_pass" integer DEFAULT 0 NOT NULL,
	"merge_minutes" integer[] DEFAULT '{}' NOT NULL,
	"prompt_score_sum" integer DEFAULT 0 NOT NULL,
	"prompt_score_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "user_metrics_daily_uq" UNIQUE NULLS NOT DISTINCT("org_id","day","user_id","repo_id")
);
--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN "is_lead" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leaderboard_snapshots" ADD CONSTRAINT "leaderboard_snapshots_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboard_snapshots" ADD CONSTRAINT "leaderboard_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_metrics_daily" ADD CONSTRAINT "user_metrics_daily_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_metrics_daily" ADD CONSTRAINT "user_metrics_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_metrics_daily" ADD CONSTRAINT "user_metrics_daily_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leaderboard_snapshots_board_idx" ON "leaderboard_snapshots" USING btree ("org_id","period","period_start","scope","scope_id","rank");--> statement-breakpoint
CREATE INDEX "user_metrics_daily_user_idx" ON "user_metrics_daily" USING btree ("org_id","user_id","day");
--> statement-breakpoint
-- Inside the org. Written only by the worker (system role): the app role reads and nothing else.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_metrics_daily', 'leaderboard_snapshots'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT USING (org_id = app_org_id())', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I FROM autodev_app', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Concatenates arrays across rows, for medians over user_metrics_daily.merge_minutes.
CREATE AGGREGATE array_cat_agg(anycompatiblearray) (SFUNC = array_cat, STYPE = anycompatiblearray, INITCOND = '{}');
