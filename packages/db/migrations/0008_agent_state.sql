ALTER TABLE "agent_runs" ADD COLUMN "state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_questions" ADD COLUMN "paths" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "task_questions" ADD COLUMN "approved" boolean;