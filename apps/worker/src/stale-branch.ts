import { PublishError, type Publisher } from '@autodev/agent';
import { and, eq, isNull, lt, or, schema, sql, type SystemDb } from '@autodev/db';

const { notifications, orgs, tasks } = schema;

/**
 * Nightly: tasks whose branch was pushed but never got a PR for more than the org's
 * stale_branch_days. Depending on stale_branch_action, open the PR (as the owner, created_by
 * stale_job) or notify the owner once.
 */
export interface StaleBranch {
  orgId: string;
  taskId: string;
  repoId: string;
  days: number;
}

export async function sweepStaleBranches(deps: {
  sys: SystemDb;
  publisher: Publisher;
  now?: Date;
  /** Told about every stale branch found (the admins' stale_branch.found event). */
  onStale?: (s: StaleBranch) => Promise<void>;
}) {
  const now = deps.now ?? new Date();
  const stale = await deps.sys
    .select({ task: tasks, action: orgs.staleBranchAction, days: orgs.staleBranchDays })
    .from(tasks)
    .innerJoin(orgs, eq(orgs.id, tasks.orgId))
    .where(and(eq(tasks.status, 'pushed'), lt(tasks.lastPushedAt, sql`${now.toISOString()}::timestamptz - make_interval(days => ${orgs.staleBranchDays})`)));

  let opened = 0;
  let notified = 0;
  for (const { task, action, days } of stale) {
    await deps.onStale?.({ orgId: task.orgId, taskId: task.id, repoId: task.repoId, days });
    if (action === 'auto_open_pr') {
      try {
        await deps.publisher.openOrUpdatePr(task.id, { actorUserId: task.ownerId, createdBy: 'stale_job' });
        opened++;
        continue;
      } catch (e) {
        if (!(e instanceof PublishError)) throw e;
        // Couldn't open it (permissions…): fall back to telling the owner.
      }
    }
    const [claimed] = await deps.sys
      .update(tasks)
      .set({ staleNotifiedAt: now })
      .where(and(eq(tasks.id, task.id), or(isNull(tasks.staleNotifiedAt), lt(tasks.staleNotifiedAt, tasks.lastPushedAt))))
      .returning({ id: tasks.id });
    if (!claimed) continue;
    await deps.sys.insert(notifications).values({
      orgId: task.orgId,
      userId: task.ownerId,
      type: 'branch.stale',
      title: `${task.key} has been pushed for ${days}+ days without a PR`,
      body: `Open a PR for ${task.workBranch}, or cancel the task.`,
      link: `/tasks/${task.key}`,
    });
    notified++;
  }
  return { checked: stale.length, opened, notified };
}
