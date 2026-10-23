-- B-6: billing. subscriptions mirrors Stripe per org; stripe_events dedupes webhook deliveries.
CREATE TYPE "public"."billing_plan" AS ENUM('team', 'business', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused');--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"plan" "billing_plan" NOT NULL,
	"status" "subscription_status" NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_item_id" text,
	"seats" integer DEFAULT 1 NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"grace_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_stripe_subscription_uq" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscriptions_customer_idx" ON "subscriptions" USING btree ("stripe_customer_id");
--> statement-breakpoint
-- Members of the org read their subscription; only the API's webhook and the seat sync (system role) write.
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read ON subscriptions FOR SELECT USING (org_id = app_org_id());
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON subscriptions FROM autodev_app;
--> statement-breakpoint
REVOKE ALL ON stripe_events FROM autodev_app;
