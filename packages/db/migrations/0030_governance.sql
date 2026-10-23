CREATE TABLE "siem_destinations" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"secret_enc" "bytea" NOT NULL,
	"data_key_version" integer NOT NULL,
	"secret_last4" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cursor_created_at" timestamp with time zone,
	"cursor_id" uuid,
	"last_sent_at" timestamp with time zone,
	"last_error" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_members" ADD COLUMN "billing_manager" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "chat_retention_days" integer;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "agent_trace_retention_days" integer;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "notification_retention_days" integer;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "ip_allowlist" "cidr"[] DEFAULT '{}'::cidr[] NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "data_region" text DEFAULT 'us' NOT NULL;--> statement-breakpoint
ALTER TABLE "siem_destinations" ADD CONSTRAINT "siem_destinations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_chat_retention_range" CHECK ("orgs"."chat_retention_days" between 7 and 3650);--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_trace_retention_range" CHECK ("orgs"."agent_trace_retention_days" between 7 and 3650);--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_notification_retention_range" CHECK ("orgs"."notification_retention_days" between 7 and 3650);--> statement-breakpoint
-- Admins manage the destination through the API (inside the org); the worker advances the cursor.
ALTER TABLE siem_destinations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE siem_destinations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON siem_destinations USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
REVOKE TRUNCATE ON siem_destinations FROM autodev_app;
