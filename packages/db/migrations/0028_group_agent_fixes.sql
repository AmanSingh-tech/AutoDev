-- B-5 part 2: Group Agent fixes are tasks flagged by_group_agent, metered as group_agent, and PRs it opens are created_by group_agent.
ALTER TYPE "public"."llm_use_case" ADD VALUE 'group_agent';--> statement-breakpoint
ALTER TYPE "public"."pr_created_by" ADD VALUE 'group_agent';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "by_group_agent" boolean DEFAULT false NOT NULL;