ALTER TABLE "builder_jobs" ADD COLUMN "kind" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD COLUMN "agent_phase" text;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD COLUMN "prompt_hash" text;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD COLUMN "result_hash" text;--> statement-breakpoint
ALTER TABLE "builders" ADD COLUMN "claude_code" text;--> statement-breakpoint
-- builders has column-level grants (token_hash is hidden from the app role): expose the new column.
GRANT SELECT (claude_code) ON builders TO autodev_app;
