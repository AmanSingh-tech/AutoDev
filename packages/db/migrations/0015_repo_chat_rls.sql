-- Phase B: repo chats are private. Only the author can read or write them, and only inside their org.
ALTER TABLE repo_chats ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE repo_chats FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY chats_owner ON repo_chats
  USING (org_id = app_org_id() AND user_id = app_user_id())
  WITH CHECK (org_id = app_org_id() AND user_id = app_user_id());
--> statement-breakpoint
ALTER TABLE repo_chat_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE repo_chat_messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY chat_messages_owner ON repo_chat_messages
  USING (org_id = app_org_id() AND user_id = app_user_id())
  WITH CHECK (org_id = app_org_id() AND user_id = app_user_id());
