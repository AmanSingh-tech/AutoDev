-- B-2: the chat tables take the brief's names (chat_sessions, chat_messages). Data, RLS policies and
-- grants follow the tables; constraint and index names are renamed to match the schema.
ALTER TABLE "repo_chats" RENAME TO "chat_sessions";--> statement-breakpoint
ALTER TABLE "chat_sessions" RENAME CONSTRAINT "repo_chats_pkey" TO "chat_sessions_pkey";--> statement-breakpoint
ALTER TABLE "chat_sessions" RENAME CONSTRAINT "repo_chats_org_id_orgs_id_fk" TO "chat_sessions_org_id_orgs_id_fk";--> statement-breakpoint
ALTER TABLE "chat_sessions" RENAME CONSTRAINT "repo_chats_repo_id_repos_id_fk" TO "chat_sessions_repo_id_repos_id_fk";--> statement-breakpoint
ALTER TABLE "chat_sessions" RENAME CONSTRAINT "repo_chats_user_id_users_id_fk" TO "chat_sessions_user_id_users_id_fk";--> statement-breakpoint
ALTER INDEX "repo_chats_owner_idx" RENAME TO "chat_sessions_owner_idx";--> statement-breakpoint
ALTER TABLE "repo_chat_messages" RENAME TO "chat_messages";--> statement-breakpoint
ALTER TABLE "chat_messages" RENAME COLUMN "chat_id" TO "session_id";--> statement-breakpoint
ALTER TABLE "chat_messages" RENAME CONSTRAINT "repo_chat_messages_pkey" TO "chat_messages_pkey";--> statement-breakpoint
ALTER TABLE "chat_messages" RENAME CONSTRAINT "repo_chat_messages_org_id_orgs_id_fk" TO "chat_messages_org_id_orgs_id_fk";--> statement-breakpoint
ALTER TABLE "chat_messages" RENAME CONSTRAINT "repo_chat_messages_chat_id_repo_chats_id_fk" TO "chat_messages_session_id_chat_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "chat_messages" RENAME CONSTRAINT "repo_chat_messages_user_id_users_id_fk" TO "chat_messages_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "chat_messages" RENAME CONSTRAINT "repo_chat_messages_reply_to_id_repo_chat_messages_id_fk" TO "chat_messages_reply_to_id_chat_messages_id_fk";--> statement-breakpoint
ALTER INDEX "repo_chat_messages_chat_idx" RENAME TO "chat_messages_session_idx";--> statement-breakpoint
-- Sources were file paths; citations are {path, startLine?, endLine?} objects.
ALTER TABLE "chat_messages" RENAME COLUMN "sources" TO "citations";--> statement-breakpoint
UPDATE "chat_messages" SET "citations" = (
  SELECT coalesce(jsonb_agg(jsonb_build_object('path', p)), '[]'::jsonb) FROM jsonb_array_elements_text("citations") AS p
) WHERE jsonb_typeof("citations"->0) = 'string';--> statement-breakpoint
ALTER POLICY "chats_owner" ON "chat_sessions" RENAME TO "chat_sessions_owner";
