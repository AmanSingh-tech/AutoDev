import type { AgentJob } from '@autodev/config';
import { and, eq, gte, inArray, isNull, schema, sql, transitionTask, WRITE_PERMISSIONS, type SystemDb } from '@autodev/db';
import { newBranchName } from '@autodev/github';
import { groupAgentBudget } from '@autodev/llm';

const { agentPolicies, groupAgentFindings, orgs, recommendations, repos, taskEvents, tasks, userRepoAccess } = schema;

/**
 * Group Agent fixes (B-5 part 2). After a scan, open recommendations with a safe fix (patch-level
 * dependency bumps) become direct-mode tasks, as long as:
 *   - the repo's safety level is 2 or 3 (1 = suggest only) and it has a maintainer with push access,
 *   - the agent's monthly budget isn't used up, and
 *   - fewer than the weekly cap of fix tasks were started in the last 7 days.
 * The task is owned by the maintainer (their builder runs the tests) and flagged by_group_agent, so
 * it's metered on the agent's own budget and the App's bot pushes it and opens the PR.
 */
export interface FixDeps {
  sys: SystemDb;
  enqueueAgent: (data: AgentJob, jobId: string) => Promise<unknown>;
}

export type FixResult = { started: string[]; skipped?: 'disabled' | 'budget' | 'cap' };

const SEVERITY_ORDER = sql`case ${groupAgentFindings.severity} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`;

export async function proposeFixes(deps: FixDeps, orgId: string, now = new Date()): Promise<FixResult> {
  const { sys } = deps;
  const [policy] = await sys.select().from(agentPolicies).where(and(eq(agentPolicies.orgId, orgId), isNull(agentPolicies.repoId)));
  if (!policy?.enabled) return { started: [], skipped: 'disabled' };
  const budget = await groupAgentBudget(sys, orgId, now);
  if (budget.limitUsd !== null && budget.spentUsd >= budget.limitUsd) return { started: [], skipped: 'budget' };

  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const [{ n: startedThisWeek } = { n: 0 }] = await sys
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.orgId, orgId), eq(tasks.byGroupAgent, true), gte(tasks.createdAt, weekAgo)));
  const room = policy.weeklyPrCap - startedThisWeek;
  if (room <= 0) return { started: [], skipped: 'cap' };

  // Eligible: safe fixes in repos at safety level 2+, whose maintainer can still push there.
  const candidates = await sys
    .select({
      recId: recommendations.id,
      title: recommendations.title,
      bodyMd: recommendations.bodyMd,
      details: groupAgentFindings.details,
      repoId: recommendations.repoId,
      maintainer: agentPolicies.maintainerUserId,
    })
    .from(recommendations)
    .innerJoin(groupAgentFindings, eq(groupAgentFindings.id, recommendations.findingId))
    .innerJoin(agentPolicies, and(eq(agentPolicies.orgId, orgId), eq(agentPolicies.repoId, recommendations.repoId)))
    .innerJoin(repos, eq(repos.id, recommendations.repoId))
    .innerJoin(
      userRepoAccess,
      and(eq(userRepoAccess.orgId, orgId), eq(userRepoAccess.repoId, recommendations.repoId), eq(userRepoAccess.userId, agentPolicies.maintainerUserId), inArray(userRepoAccess.permission, [...WRITE_PERMISSIONS])),
    )
    .where(
      and(
        eq(recommendations.orgId, orgId),
        eq(recommendations.status, 'open'),
        eq(recommendations.fixKind, 'dependency_bump'),
        gte(agentPolicies.safetyLevel, 2),
        eq(agentPolicies.enabled, true),
        isNull(repos.deletedAt),
        eq(repos.archived, false),
      ),
    )
    .orderBy(SEVERITY_ORDER, recommendations.createdAt)
    .limit(room);

  const started: string[] = [];
  for (const c of candidates) {
    const job = await sys.transaction(async (tx) => {
      // Claim it first, so two runs never start the same fix.
      const [claimed] = await tx
        .update(recommendations)
        .set({ status: 'task_created', updatedAt: now })
        .where(and(eq(recommendations.id, c.recId), eq(recommendations.status, 'open')))
        .returning({ id: recommendations.id });
      if (!claimed) return null;
      const [seq] = await tx
        .update(orgs)
        .set({ taskSeq: sql`${orgs.taskSeq} + 1` })
        .where(eq(orgs.id, orgId))
        .returning({ n: orgs.taskSeq, prefix: orgs.taskKeyPrefix });
      const key = `${seq!.prefix}-${seq!.n}`;
      const d = c.details as { package?: string; version?: string; fixedVersion?: string; latest?: string; file?: string; ecosystem?: string; advisory?: string };
      const target = d.fixedVersion ?? d.latest;
      const [task] = await tx
        .insert(tasks)
        .values({
          orgId,
          repoId: c.repoId!,
          number: seq!.n,
          key,
          title: c.title.slice(0, 200),
          descriptionMd: [
            c.bodyMd,
            `Change \`${d.package}\` from ${d.version} to ${target} in \`${d.file}\`${d.ecosystem === 'npm' ? ' and the matching entries in its lockfile' : ''}. Keep the version range style the manifest already uses. Change nothing else.`,
            '_Opened by the Group Agent._',
          ].join('\n\n'),
          acceptanceCriteriaMd: [`- \`${d.package}\` resolves to ${target} in \`${d.file}\``, '- No other dependency changes', '- Existing tests still pass'].join('\n'),
          priority: d.advisory ? 'high' : 'low',
          mode: 'direct',
          branchMode: 'new',
          workBranch: newBranchName(key, c.title),
          createPrOnCompletion: true,
          ownerId: c.maintainer!,
          createdBy: null,
          byGroupAgent: true,
        })
        .returning();
      await tx.insert(taskEvents).values({ orgId, taskId: task!.id, actorType: 'agent', type: 'created', payload: { mode: 'direct', byGroupAgent: true, recommendationId: c.recId } });
      await tx.update(recommendations).set({ taskId: task!.id }).where(eq(recommendations.id, c.recId));
      const { eventId } = await transitionTask(tx, task!, 'queued', { type: 'agent', userId: null }, { byGroupAgent: true });
      return { taskId: task!.id, key, eventId };
    });
    if (!job) continue;
    await deps.enqueueAgent({ kind: 'run', orgId, taskId: job.taskId }, `run-${job.eventId}`);
    started.push(job.key);
  }
  return { started };
}
