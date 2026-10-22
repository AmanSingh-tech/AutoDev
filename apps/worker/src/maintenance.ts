import { sweepBlobs } from '@autodev/agent';
import { sql, type SystemDb } from '@autodev/db';
import type { BlobStore } from '@autodev/storage';
import { runInsights } from './insights';

/**
 * Housekeeping jobs on one queue, told apart by job name. Both are idempotent, so retries are safe.
 *  - partitions: keeps token_usage partitions for this month plus the next two.
 *  - blob-retention: applies each org's log and snapshot retention, then removes unreferenced blobs.
 *  - insights: B-4 rollups and leaderboards, nightly for every org, or for one org on an admin's Recompute.
 */
export const createMaintenanceProcessor = (deps: { sys: SystemDb; blobs: BlobStore }) => async (job: { name: string; data?: { orgId?: string } }) => {
  if (job.name === 'blob-retention') return sweepBlobs(deps);
  if (job.name === 'insights') return runInsights(deps.sys, { orgId: job.data?.orgId });
  await deps.sys.execute(sql`select ensure_token_usage_partitions(2)`);
  return { partitions: 'ok' };
};
