-- Content-addressed blobs (packages/storage) and per-org retention.
-- Existing blobs keep their bytes; they are renamed to their sha256, and references move from
-- the old keys to hashes. Nothing is dropped unless every reference could be mapped.

ALTER TABLE "blobs" RENAME TO "blobs_legacy";
--> statement-breakpoint
CREATE TABLE "blobs" (
	"hash" text PRIMARY KEY NOT NULL,
	"size" integer NOT NULL,
	"encoding" text DEFAULT 'gzip' NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "blobs" ("hash", "size", "encoding", "content", "created_at")
SELECT encode(sha256("content"), 'hex'), length("content"), 'identity', "content", "created_at"
FROM "blobs_legacy"
ON CONFLICT ("hash") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD COLUMN "patch_hash" text;
--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD COLUMN "log_hash" text;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "transcript_hash" text;
--> statement-breakpoint
UPDATE "builder_jobs" j SET "patch_hash" = encode(sha256(b."content"), 'hex')
FROM "blobs_legacy" b WHERE b."key" = j."patch_key";
--> statement-breakpoint
UPDATE "builder_jobs" j SET "log_hash" = encode(sha256(b."content"), 'hex')
FROM "blobs_legacy" b WHERE b."key" = j."log_key";
--> statement-breakpoint
UPDATE "agent_runs" r SET "transcript_hash" = encode(sha256(b."content"), 'hex')
FROM "blobs_legacy" b WHERE b."key" = r."transcript_key";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "builder_jobs" WHERE "patch_hash" IS NULL) THEN
    RAISE EXCEPTION 'builder_jobs has patches with no stored blob; fix them before running this migration';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "builder_jobs" ALTER COLUMN "patch_hash" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "builder_jobs" DROP COLUMN "patch_key";
--> statement-breakpoint
ALTER TABLE "builder_jobs" DROP COLUMN "log_key";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN "transcript_key";
--> statement-breakpoint
DROP TABLE "blobs_legacy";
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "log_retention_days" integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "snapshot_retention_days" integer DEFAULT 14 NOT NULL;
--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_log_retention_range" CHECK ("orgs"."log_retention_days" between 7 and 365);
--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_snapshot_retention_range" CHECK ("orgs"."snapshot_retention_days" between 1 and 90);
