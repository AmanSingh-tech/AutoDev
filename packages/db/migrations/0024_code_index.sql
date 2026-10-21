-- B-2 part 2: the code index (chunks with embeddings, and each repo's index state).
-- docker/postgres/init.sh already creates the extension; this covers databases set up another way.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."code_index_status" AS ENUM('pending', 'indexing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "code_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"path" text NOT NULL,
	"blob_sha" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"language" text,
	"symbol" text,
	"content" text NOT NULL,
	"tsv" "tsvector" NOT NULL,
	"embedding" vector(768) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_index_state" (
	"repo_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"status" "code_index_status" DEFAULT 'pending' NOT NULL,
	"commit_sha" text,
	"model" text,
	"files" integer DEFAULT 0 NOT NULL,
	"chunks" integer DEFAULT 0 NOT NULL,
	"skipped_files" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_state" ADD CONSTRAINT "code_index_state_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_state" ADD CONSTRAINT "code_index_state_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_chunks_repo_path_idx" ON "code_chunks" USING btree ("repo_id","path");--> statement-breakpoint
CREATE INDEX "code_chunks_tsv_idx" ON "code_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "code_chunks_embedding_idx" ON "code_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
-- Inside the org, and only for people with access to the repo (the same rule as the chat tables).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['code_chunks', 'code_index_state'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY repo_readers ON %I USING (org_id = app_org_id() AND EXISTS (SELECT 1 FROM user_repo_access a WHERE a.user_id = app_user_id() AND a.repo_id = %I.repo_id))',
      t, t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Only the worker (system role) writes the index.
REVOKE INSERT, UPDATE, DELETE ON code_chunks, code_index_state FROM autodev_app;
--> statement-breakpoint
-- Realtime (see packages/events/src/changes.ts).
CREATE TRIGGER code_index_state_row_change AFTER INSERT OR UPDATE ON "code_index_state" FOR EACH ROW EXECUTE FUNCTION notify_row_change('repo_id', 'org_id', 'status', 'commit_sha');
