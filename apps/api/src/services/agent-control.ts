import { and, desc, eq, schema, type SystemDb, type Tx } from '@autodev/db';
import type { Deps } from '../deps';
import { transition } from './tasks';

const { agentRuns, tasks } = schema;

/** Queues the agent for a task; the worker re-reads the task, so duplicates are harmless. */
export const enqueueAgent = (deps: Pick<Deps, 'queues'>, orgId: string, taskId: string, eventId: string) =>
  deps.queues.agent.add('run', { kind: 'run', orgId, taskId }, { jobId: `run-${eventId}` });

/** Where a blocked_on_key or needs_input task goes back to: the status its paused run was in. */
export async function resumeStatusOf(db: SystemDb | Tx, taskId: string) {
  const [run] = await db
    .select({ resumeStatus: agentRuns.resumeStatus })
    .from(agentRuns)
    .where(and(eq(agentRuns.taskId, taskId), eq(agentRuns.status, 'paused')))
    .orderBy(desc(agentRuns.startedAt))
    .limit(1);
  return run?.resumeStatus ?? null;
}

/**
 * After a working key is added, resume every task in the org that was blocked on a key and can
 * now resolve one (a personal key only helps its owner's tasks).
 */
export async function resumeBlockedTasks(deps: Deps, orgId: string, actorUserId: string) {
  const blocked = await deps.sys.select().from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.status, 'blocked_on_key')));
  let resumed = 0;
  for (const t of blocked) {
    const policy = await deps.gateway.policy(orgId, 'agent');
    if (!(await deps.gateway.resolveCredential(orgId, t.ownerId, policy.provider))) continue;
    const to = await resumeStatusOf(deps.sys, t.id);
    if (!to) continue;
    try {
      const { eventId } = await transition(deps.sys, t, to, { type: 'user', userId: actorUserId }, { reason: 'key_restored' });
      await enqueueAgent(deps, orgId, t.id, eventId);
      resumed++;
    } catch {
      // Someone else moved it; nothing to do.
    }
  }
  return resumed;
}
