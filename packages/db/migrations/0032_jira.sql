CREATE TABLE "jira_connections" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"site" text NOT NULL,
	"email" text NOT NULL,
	"token_enc" "bytea" NOT NULL,
	"data_key_version" integer NOT NULL,
	"token_last4" text NOT NULL,
	"default_project" text,
	"webhook_token" text NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "jira_issue_key" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "jira_issue_status" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "jira_synced_status" text;--> statement-breakpoint
ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_jira_idx" ON "tasks" USING btree ("org_id","jira_issue_key") WHERE "tasks"."jira_issue_key" is not null;--> statement-breakpoint
-- Admins manage the connection through the API (inside the org); the worker and webhook use the system role.
ALTER TABLE jira_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON jira_connections USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
REVOKE TRUNCATE ON jira_connections FROM autodev_app;
