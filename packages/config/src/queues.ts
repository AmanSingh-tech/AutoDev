import { z } from 'zod';

/** BullMQ queue names. Only these four exist in Section A; more get added here. */
export const QUEUES = {
  repoSync: 'repo-sync',
  agent: 'agent',
  keyValidation: 'key-validation',
  staleBranch: 'stale-branch',
  /** Repo chat: answers one question at a time, reading the repo with the asker's token. */
  chat: 'chat',
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

/**
 * Enqueued when someone asks a private repo chat question (`answer`) or mentions the Repo Agent in
 * a team room (`room`). The job answers the pending message.
 */
export const chatJob = z.object({
  kind: z.enum(['answer', 'room']),
  orgId: z.string().uuid(),
  messageId: z.string().uuid(),
});
export type ChatJob = z.infer<typeof chatJob>;

/** Just enough of a BullMQ Queue for producers, so they can be faked in tests. */
export interface JobQueue<T> {
  add(name: string, data: T, opts?: { jobId?: string; delay?: number }): Promise<unknown>;
}
