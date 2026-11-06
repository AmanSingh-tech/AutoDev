CREATE TABLE "autopilot_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"stop_reason" text,
	"tasks_started" integer DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reviewed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autopilot_settings" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"start_minute" integer DEFAULT 1140 NOT NULL,
	"end_minute" integer DEFAULT 420 NOT NULL,
	"days" integer[] DEFAULT '{1,2,3,4,5}'::int[] NOT NULL,
	"nightly_budget_usd" numeric(10, 2) DEFAULT '20.00' NOT NULL,
	"max_tasks" integer DEFAULT 5 NOT NULL,
	"run_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autopilot_settings_org_id_user_id_pk" PRIMARY KEY("org_id","user_id"),
	CONSTRAINT "autopilot_window_range" CHECK ("autopilot_settings"."start_minute" between 0 and 1439 and "autopilot_settings"."end_minute" between 0 and 1439),
	CONSTRAINT "autopilot_max_tasks_range" CHECK ("autopilot_settings"."max_tasks" between 1 and 50)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "autopilot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "autopilot_run_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "autopilot_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "autopilot_runs" ADD CONSTRAINT "autopilot_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_runs" ADD CONSTRAINT "autopilot_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_settings" ADD CONSTRAINT "autopilot_settings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_settings" ADD CONSTRAINT "autopilot_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "autopilot_runs_user_idx" ON "autopilot_runs" USING btree ("org_id","user_id","created_at");--> statement-breakpoint
-- Settings: changed through the API inside the org (each person only their own row, checked there).
ALTER TABLE autopilot_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE autopilot_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON autopilot_settings USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
REVOKE TRUNCATE ON autopilot_settings FROM autodev_app;
--> statement-breakpoint
-- Runs: written by the worker's scheduler (system role); members read their org's.
ALTER TABLE autopilot_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE autopilot_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read ON autopilot_runs FOR SELECT USING (org_id = app_org_id());
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON autopilot_runs FROM autodev_app;
