import { sql, type SystemDb } from '@autodev/db';

/** Keeps token_usage partitions for this month plus the next two. Idempotent, so it's safe to run often. */
export const createMaintenanceProcessor = (sys: SystemDb) => async () => {
  await sys.execute(sql`select ensure_token_usage_partitions(2)`);
  return { partitions: 'ok' };
};
