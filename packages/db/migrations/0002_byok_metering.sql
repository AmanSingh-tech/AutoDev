CREATE TYPE "public"."budget_scope" AS ENUM('org', 'user');--> statement-breakpoint
CREATE TYPE "public"."credential_scope" AS ENUM('org', 'team', 'user');--> statement-breakpoint
CREATE TYPE "public"."credential_status" AS ENUM('active', 'invalid', 'superseded', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."llm_provider" AS ENUM('anthropic', 'openai', 'azure_openai', 'bedrock');--> statement-breakpoint
CREATE TYPE "public"."llm_use_case" AS ENUM('agent');--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"scope" "budget_scope" NOT NULL,
	"user_id" uuid,
	"limit_usd" numeric(12, 2) NOT NULL,
	"soft_pct" integer DEFAULT 80 NOT NULL,
	"hard_block" boolean DEFAULT true NOT NULL,
	"last_soft_alert_month" date,
	"last_hard_alert_month" date,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_scope_target" CHECK (("budgets"."scope" = 'org') = ("budgets"."user_id" is null)),
	CONSTRAINT "budgets_soft_pct_range" CHECK ("budgets"."soft_pct" between 1 and 100),
	CONSTRAINT "budgets_limit_positive" CHECK ("budgets"."limit_usd" > 0)
);
--> statement-breakpoint
CREATE TABLE "llm_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"scope" "credential_scope" NOT NULL,
	"team_id" uuid,
	"user_id" uuid,
	"provider" "llm_provider" NOT NULL,
	"label" text NOT NULL,
	"secret_enc" "bytea" NOT NULL,
	"data_key_version" integer NOT NULL,
	"last4" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "credential_status" DEFAULT 'active' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"rotated_from_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_credentials_scope_target" CHECK (("llm_credentials"."scope" = 'org' and "llm_credentials"."team_id" is null and "llm_credentials"."user_id" is null)
       or ("llm_credentials"."scope" = 'team' and "llm_credentials"."team_id" is not null and "llm_credentials"."user_id" is null)
       or ("llm_credentials"."scope" = 'user' and "llm_credentials"."user_id" is not null and "llm_credentials"."team_id" is null))
);
--> statement-breakpoint
CREATE TABLE "model_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"use_case" "llm_use_case" NOT NULL,
	"provider" "llm_provider" NOT NULL,
	"model" text NOT NULL,
	"max_tokens_per_task" bigint NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"effort" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_policies_org_use_case_uq" UNIQUE("org_id","use_case"),
	CONSTRAINT "model_policies_caps_positive" CHECK ("model_policies"."max_tokens_per_task" > 0 and "model_policies"."max_output_tokens" > 0)
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"provider" "llm_provider" NOT NULL,
	"model" text NOT NULL,
	"input_per_mtok" numeric(12, 6) NOT NULL,
	"output_per_mtok" numeric(12, 6) NOT NULL,
	"cache_write_5m_per_mtok" numeric(12, 6) NOT NULL,
	"cache_write_1h_per_mtok" numeric(12, 6) NOT NULL,
	"cache_read_per_mtok" numeric(12, 6) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_usage" (
	"id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"repo_id" uuid,
	"task_id" uuid,
	"agent_run_id" uuid,
	"credential_id" uuid,
	"credential_scope" "credential_scope",
	"provider" "llm_provider" NOT NULL,
	"model" text NOT NULL,
	"use_case" "llm_use_case" NOT NULL,
	"provider_request_id" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_5m_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_1h_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 6) DEFAULT '0' NOT NULL,
	"priced" boolean DEFAULT true NOT NULL,
	"model_price_id" uuid,
	CONSTRAINT "token_usage_id_created_at_pk" PRIMARY KEY("id","created_at")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
ALTER TABLE "org_members" ADD COLUMN "primary_team_id" uuid;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "allow_user_keys" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_credentials" ADD CONSTRAINT "llm_credentials_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_credentials" ADD CONSTRAINT "llm_credentials_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_credentials" ADD CONSTRAINT "llm_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_credentials" ADD CONSTRAINT "llm_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_policies" ADD CONSTRAINT "model_policies_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_policies" ADD CONSTRAINT "model_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_one_per_target" ON "budgets" USING btree ("org_id","scope",coalesce("user_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE UNIQUE INDEX "llm_credentials_one_active" ON "llm_credentials" USING btree ("org_id","provider","scope",coalesce("team_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("user_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "llm_credentials"."status" = 'active';--> statement-breakpoint
CREATE INDEX "llm_credentials_org_idx" ON "llm_credentials" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "model_prices_one_current" ON "model_prices" USING btree (coalesce("org_id", '00000000-0000-0000-0000-000000000000'::uuid),"provider","model") WHERE "model_prices"."effective_to" is null;--> statement-breakpoint
CREATE INDEX "token_usage_org_created_idx" ON "token_usage" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "token_usage_org_user_created_idx" ON "token_usage" USING btree ("org_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "token_usage_task_idx" ON "token_usage" USING btree ("task_id");