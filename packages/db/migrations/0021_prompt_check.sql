-- B-1 Prompt guide: org task templates, the draft score on tasks, and the use case renamed to the brief's name.
-- RENAME VALUE keeps existing policies and usage rows (drizzle-kit would drop and recreate the type).
ALTER TYPE "public"."llm_use_case" RENAME VALUE 'prompt_guide' TO 'prompt_check';--> statement-breakpoint
CREATE TABLE "prompt_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"description_md" text DEFAULT '' NOT NULL,
	"acceptance_criteria_md" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_templates_org_name_uq" UNIQUE("org_id","name"),
	CONSTRAINT "prompt_templates_name_length" CHECK (char_length("prompt_templates"."name") between 1 and 80),
	CONSTRAINT "prompt_templates_kind" CHECK ("prompt_templates"."kind" in ('bug_fix', 'feature', 'refactor', 'add_tests', 'ui_change'))
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "prompt_score" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "prompt_score_details" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "prompt_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_prompt_score_range" CHECK ("tasks"."prompt_score" is null or "tasks"."prompt_score" between 0 and 100);--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE prompt_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE prompt_templates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON prompt_templates USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
