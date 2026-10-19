CREATE TYPE "public"."chat_message_status" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."chat_role" AS ENUM('user', 'assistant');--> statement-breakpoint
ALTER TYPE "public"."llm_use_case" ADD VALUE 'chat';--> statement-breakpoint
CREATE TABLE "repo_chat_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "chat_role" NOT NULL,
	"status" "chat_message_status" DEFAULT 'done' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"reply_to_id" uuid,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repo_chats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repo_chat_messages" ADD CONSTRAINT "repo_chat_messages_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_chat_messages" ADD CONSTRAINT "repo_chat_messages_chat_id_repo_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."repo_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_chat_messages" ADD CONSTRAINT "repo_chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_chat_messages" ADD CONSTRAINT "repo_chat_messages_reply_to_id_repo_chat_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."repo_chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_chats" ADD CONSTRAINT "repo_chats_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_chats" ADD CONSTRAINT "repo_chats_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_chats" ADD CONSTRAINT "repo_chats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repo_chat_messages_chat_idx" ON "repo_chat_messages" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "repo_chats_owner_idx" ON "repo_chats" USING btree ("org_id","user_id","repo_id","updated_at");