import { z } from 'zod';

/** BullMQ queue names. Only these four exist in Section A; more get added here. */
export const QUEUES = {
  repoSync: 'repo-sync',
  agent: 'agent',
  keyValidation: 'key-validation',
  staleBranch: 'stale-branch',
  /** Repo chat: answers one question at a time, reading the repo with the asker's token. */
  chat: 'chat',
  /** The code index (B-2): chunk and embed a repo's default branch, or delete an org's index. */
  codeIndex: 'code-index',
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

/**
 * `repo` brings one repo's index up to date; `org` queues a `repo` job for each repo of an org;
 * `nightly` does that for every org with the index on; `purge` deletes an org's index.
 */
export const codeIndexJob = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('repo'), orgId: z.string().uuid(), repoId: z.string().uuid() }),
  z.object({ kind: z.literal('org'), orgId: z.string().uuid() }),
  z.object({ kind: z.literal('nightly') }),
  z.object({ kind: z.literal('purge'), orgId: z.string().uuid() }),
]);
export type CodeIndexJob = z.infer<typeof codeIndexJob>;

/** Insights (B-4) on the maintenance queue: one org on an admin's Recompute (nightly runs have no orgId). */
export const insightsJob = z.object({ orgId: z.string().uuid().optional() });
export type InsightsJob = z.infer<typeof insightsJob>;
/** One waiting run per org, so repeated Recompute clicks share it. */
export const insightsJobId = (orgId: string) => `insights-${orgId}`;

/** One waiting run per repo. Pushes within this window share a run. */
export const CODE_INDEX_PUSH_DELAY_MS = 30_000;
export const codeIndexRepoJobId = (repoId: string) => `repo-${repoId}`;

/** Just enough of a BullMQ Queue for producers, so they can be faked in tests. */
export interface JobQueue<T> {
  add(name: string, data: T, opts?: { jobId?: string; delay?: number }): Promise<unknown>;
}
