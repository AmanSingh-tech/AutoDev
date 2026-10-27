CREATE TABLE "directory_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"directory_user_id" text NOT NULL,
	"idp_id" text,
	"email" text,
	"name" text,
	"state" text NOT NULL,
	"user_id" uuid,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_users_org_dir_uq" UNIQUE("org_id","directory_user_id")
);
--> statement-breakpoint
CREATE TABLE "org_sso" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"workos_organization_id" text NOT NULL,
	"workos_directory_id" text,
	"sso_required" boolean DEFAULT false NOT NULL,
	"session_hours" integer DEFAULT 24 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_sso_workos_organization_id_unique" UNIQUE("workos_organization_id"),
	CONSTRAINT "org_sso_session_hours_range" CHECK ("org_sso"."session_hours" between 1 and 720)
);
--> statement-breakpoint
CREATE TABLE "sso_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_id" text NOT NULL,
	"idp_id" text,
	"email" text NOT NULL,
	"last_login_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_identities_org_user_uq" UNIQUE("org_id","user_id"),
	CONSTRAINT "sso_identities_org_profile_uq" UNIQUE("org_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "workos_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "directory_users" ADD CONSTRAINT "directory_users_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_users" ADD CONSTRAINT "directory_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_sso" ADD CONSTRAINT "org_sso_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "directory_users_email_idx" ON "directory_users" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "sso_identities_email_idx" ON "sso_identities" USING btree ("org_id","email");--> statement-breakpoint
-- Admins change org_sso through the API; identities and directory users are written by the
-- system role only (the SSO callback and WorkOS webhooks). Members read their org's rows.
ALTER TABLE org_sso ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE org_sso FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON org_sso USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
REVOKE TRUNCATE ON org_sso FROM autodev_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sso_identities', 'directory_users'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT USING (org_id = app_org_id())', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I FROM autodev_app', t);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON workos_events FROM autodev_app;
