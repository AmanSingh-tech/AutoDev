import { z } from 'zod';

/** BullMQ queue names. Only these four exist in Section A; more get added here. */
export const QUEUES = {
  repoSync: 'repo-sync',
  agent: 'agent',
  keyValidation: 'key-validation',
  /** Housekeeping (token_usage partitions). Not in the original queue list; small and separate. */
  maintenance: 'maintenance',
} as const;

export const repoSyncJob = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('installation'), githubInstallationId: z.number().int().positive() }),
]);
export type RepoSyncJob = z.infer<typeof repoSyncJob>;

/** Enqueued when a task is started. The agent worker (A-4) re-reads the task, so stale jobs are no-ops. */
export const agentJob = z.object({
  kind: z.literal('run'),
  orgId: z.string().uuid(),
  taskId: z.string().uuid(),
});
export type AgentJob = z.infer<typeof agentJob>;

/** Just enough of a BullMQ Queue for producers, so they can be faked in tests. */
export interface JobQueue<T> {
  add(name: string, data: T, opts?: { jobId?: string; delay?: number }): Promise<unknown>;
}
