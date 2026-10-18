import { z } from 'zod';

/** BullMQ queue names. Only these four exist in Section A; more get added here. */
export const QUEUES = {
  repoSync: 'repo-sync',
  keyValidation: 'key-validation',
  /** Housekeeping (token_usage partitions). Not in the original queue list; small and separate. */
  maintenance: 'maintenance',
} as const;

export const repoSyncJob = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('installation'), githubInstallationId: z.number().int().positive() }),
]);
export type RepoSyncJob = z.infer<typeof repoSyncJob>;

/** Just enough of a BullMQ Queue for producers, so they can be faked in tests. */
export interface JobQueue<T> {
  add(name: string, data: T, opts?: { jobId?: string; delay?: number }): Promise<unknown>;
}
