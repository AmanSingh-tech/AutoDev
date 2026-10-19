import { sql, type SystemDb } from '@autodev/db';
import type { BlobStore } from '@autodev/storage';

/** A new blob is not deleted for this long, in case a row that points to it is still being written. */
export const BLOB_GRACE_HOURS = 24;

export interface RetentionReport {
  logsCleared: number;
  snapshotsCleared: number;
  blobsDeleted: number;
  blobsKept: number;
}

/**
 * Nightly cleanup. Each org's own retention applies:
 *  - builder logs older than log_retention_days lose their pointer (the job row stays);
 *  - transcripts (workspace snapshots) of tasks finished longer ago than snapshot_retention_days
 *    lose their pointer;
 *  - patches are never cleared;
 *  - then blobs that no row points to, and that are older than the grace period, are deleted.
 */
export async function sweepBlobs(
  deps: { sys: SystemDb; blobs: BlobStore },
  now = new Date(),
): Promise<RetentionReport> {
  const { sys, blobs } = deps;
  const at = now.toISOString();

  const logs = await sys.execute(sql`
    update builder_jobs j set log_hash = null
    from orgs o
    where o.id = j.org_id
      and j.log_hash is not null
      and j.finished_at is not null
      and j.finished_at < ${at}::timestamptz - make_interval(days => o.log_retention_days)
    returning j.id`);

  const snapshots = await sys.execute(sql`
    update agent_runs r set transcript_hash = null
    from tasks t, orgs o
    where t.id = r.task_id
      and o.id = r.org_id
      and r.transcript_hash is not null
      and t.completed_at is not null
      and t.completed_at < ${at}::timestamptz - make_interval(days => o.snapshot_retention_days)
    returning r.id`);

  const referenced = await referencedHashes(sys);
  const cutoff = now.getTime() - BLOB_GRACE_HOURS * 3_600_000;
  let blobsDeleted = 0;
  let blobsKept = 0;
  for await (const { hash, createdAt } of blobs.list()) {
    if (referenced.has(hash) || createdAt.getTime() > cutoff) {
      blobsKept++;
      continue;
    }
    await blobs.delete(hash);
    blobsDeleted++;
  }
  return { logsCleared: logs.length, snapshotsCleared: snapshots.length, blobsDeleted, blobsKept };
}

async function referencedHashes(sys: SystemDb): Promise<Set<string>> {
  const rows = await sys.execute(sql`
    select patch_hash as hash from builder_jobs
    union select log_hash from builder_jobs where log_hash is not null
    union select transcript_hash from agent_runs where transcript_hash is not null`);
  return new Set(rows.map((r) => (r as { hash: string }).hash));
}
