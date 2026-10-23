import { groupAgentScanJobId } from '@autodev/config';
import { and, asc, desc, eq, FINDING_KINDS, FINDING_SEVERITIES, inArray, isNull, schema, sql, WRITE_PERMISSIONS } from '@autodev/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, router } from '../trpc';
import { assertCanWork, insertTask } from './tasks';

const { agentPolicies, groupAgentFindings, groupAgentRuns, orgMembers, recommendations, repos, tasks, userRepoAccess, users } = schema;

/** Task states that mean the work was dropped, so its recommendation can be reopened. */
const DROPPED: string[] = ['cancelled', 'rejected', 'failed'];

/** Mirrors apps/worker/src/group-agent/run.ts HEALTH_PENALTY. */
const PENALTY = { low: 2, medium: 7, high: 15, critical: 30 } as const;

/**
 * The Group Agent (B-5): org-wide scans the worker runs nightly, their findings and recommendations,
 * the weekly digest, and its settings. Admins only. Findings are written by the worker; people
 * dismiss recommendations or turn them into tasks.
 */
export const groupAgentRouter = router({
  /** The page header: on/off, last scan, health per repo, open counts by severity. */
  overview: adminProcedure.query(({ ctx }) =>
    ctx.inOrg(async (tx) => {
      const [policy] = await tx.select().from(agentPolicies).where(and(eq(agentPolicies.orgId, ctx.orgId), isNull(agentPolicies.repoId)));
      const [lastScan] = await tx
        .select()
        .from(groupAgentRuns)
        .where(and(eq(groupAgentRuns.orgId, ctx.orgId), eq(groupAgentRuns.kind, 'scan')))
        .orderBy(desc(groupAgentRuns.startedAt))
        .limit(1);
      const repoRows = await tx.select({ id: repos.id, fullName: repos.fullName }).from(repos).where(and(eq(repos.orgId, ctx.orgId), isNull(repos.deletedAt))).orderBy(asc(repos.fullName));
      const open = await tx
        .select({ repoId: groupAgentFindings.repoId, severity: groupAgentFindings.severity, details: groupAgentFindings.details })
        .from(groupAgentFindings)
        .where(and(eq(groupAgentFindings.orgId, ctx.orgId), isNull(groupAgentFindings.resolvedAt)));
      const health = new Map(repoRows.map((r) => [r.id, { repoId: r.id, name: r.fullName, score: 100, open: 0 }]));
      const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const f of open) {
        bySeverity[f.severity]++;
        for (const id of f.repoId ? [f.repoId] : ((f.details.repoIds as string[] | undefined) ?? [])) {
          const h = health.get(id);
          if (!h) continue;
          h.score = Math.max(0, h.score - PENALTY[f.severity]);
          h.open++;
        }
      }
      return {
        enabled: policy?.enabled ?? false,
        lastScan: lastScan ? { status: lastScan.status, startedAt: lastScan.startedAt, finishedAt: lastScan.finishedAt, errors: (lastScan.payload.errors as { check: string; repo?: string; message: string }[] | undefined) ?? [] } : null,
        bySeverity,
        repos: [...health.values()].sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)),
      };
    }),
  ),

  recommendations: adminProcedure
    .input(
      z.object({
        status: z.enum(['open', 'dismissed', 'task_created', 'resolved', 'all']).default('open'),
        repoId: z.string().uuid().optional(),
        kind: z.enum(FINDING_KINDS).optional(),
        severity: z.enum(FINDING_SEVERITIES).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.inOrg((tx) =>
        tx
          .select({
            id: recommendations.id,
            status: recommendations.status,
            title: recommendations.title,
            bodyMd: recommendations.bodyMd,
            fixKind: recommendations.fixKind,
            dismissedReason: recommendations.dismissedReason,
            updatedAt: recommendations.updatedAt,
            kind: groupAgentFindings.kind,
            severity: groupAgentFindings.severity,
            finding: groupAgentFindings.title,
            details: groupAgentFindings.details,
            firstSeenAt: groupAgentFindings.firstSeenAt,
            lastSeenAt: groupAgentFindings.lastSeenAt,
            repoId: recommendations.repoId,
            repo: repos.fullName,
            taskKey: tasks.key,
            taskStatus: tasks.status,
          })
          .from(recommendations)
          .innerJoin(groupAgentFindings, eq(groupAgentFindings.id, recommendations.findingId))
          .leftJoin(repos, eq(repos.id, recommendations.repoId))
          .leftJoin(tasks, eq(tasks.id, recommendations.taskId))
          .where(
            and(
              eq(recommendations.orgId, ctx.orgId),
              input.status === 'all' ? undefined : eq(recommendations.status, input.status),
              input.repoId ? eq(recommendations.repoId, input.repoId) : undefined,
              input.kind ? eq(groupAgentFindings.kind, input.kind) : undefined,
              input.severity ? eq(groupAgentFindings.severity, input.severity) : undefined,
            ),
          )
          .orderBy(sql`case ${groupAgentFindings.severity} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`, desc(groupAgentFindings.lastSeenAt))
          .limit(300),
      ),
    ),

  dismiss: adminProcedure.input(z.object({ id: z.string().uuid(), reason: z.string().trim().min(1).max(500) })).mutation(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      const [row] = await tx
        .update(recommendations)
        .set({ status: 'dismissed', dismissedBy: ctx.userId, dismissedReason: input.reason, updatedAt: new Date() })
        .where(and(eq(recommendations.id, input.id), eq(recommendations.orgId, ctx.orgId), inArray(recommendations.status, ['open', 'resolved'])))
        .returning();
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'No open recommendation with that id' });
      await ctx.audit(tx, { action: 'recommendation.dismissed', targetType: 'recommendation', targetId: row.id, metadata: { title: row.title, reason: input.reason } });
      return { ok: true };
    }),
  ),

  /** Back to open: after a mistaken dismissal, or when the task made from it was dropped (cancelled, rejected, failed). */
  reopen: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      const [current] = await tx
        .select({ status: recommendations.status, taskStatus: tasks.status })
        .from(recommendations)
        .leftJoin(tasks, eq(tasks.id, recommendations.taskId))
        .where(and(eq(recommendations.id, input.id), eq(recommendations.orgId, ctx.orgId)));
      const reopenable = current?.status === 'dismissed' || (current?.status === 'task_created' && (!current.taskStatus || DROPPED.includes(current.taskStatus)));
      if (!reopenable) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only dismissed recommendations, or ones whose task was dropped, can be reopened' });
      const [row] = await tx
        .update(recommendations)
        .set({ status: 'open', dismissedBy: null, dismissedReason: null, taskId: null, updatedAt: new Date() })
        .where(and(eq(recommendations.id, input.id), eq(recommendations.orgId, ctx.orgId)))
        .returning();
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Recommendation not found' });
      await ctx.audit(tx, { action: 'recommendation.reopened', targetType: 'recommendation', targetId: row.id });
      return { ok: true };
    }),
  ),

  /** One click: a draft task in the recommendation's repo, owned by the admin who clicks (who needs push access). */
  createTask: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const [rec] = await ctx.inOrg((tx) =>
      tx
        .select({ id: recommendations.id, status: recommendations.status, title: recommendations.title, bodyMd: recommendations.bodyMd, repoId: recommendations.repoId, details: groupAgentFindings.details })
        .from(recommendations)
        .innerJoin(groupAgentFindings, eq(groupAgentFindings.id, recommendations.findingId))
        .where(and(eq(recommendations.id, input.id), eq(recommendations.orgId, ctx.orgId))),
    );
    if (!rec) throw new TRPCError({ code: 'NOT_FOUND', message: 'Recommendation not found' });
    if (rec.status === 'task_created') throw new TRPCError({ code: 'CONFLICT', message: 'A task was already created for this' });
    const repoId = rec.repoId ?? (rec.details.repoIds as string[] | undefined)?.[0];
    if (!repoId) throw new TRPCError({ code: 'BAD_REQUEST', message: "This recommendation isn't about one repository; create a task from the repository it applies to" });
    await assertCanWork(ctx, repoId);
    return ctx.inOrg(async (tx) => {
      const task = await insertTask(tx, ctx, repoId, {
        title: rec.title.slice(0, 200),
        descriptionMd: `${rec.bodyMd}\n\n_From a Group Agent recommendation._`.slice(0, 20_000),
        acceptanceCriteriaMd: '',
        priority: 'medium',
        scopePath: null,
        branchMode: 'new',
        targetBranch: null,
        relatedTaskId: null,
        createPrOnCompletion: true,
      });
      await tx.update(recommendations).set({ status: 'task_created', taskId: task.id, updatedAt: new Date() }).where(eq(recommendations.id, rec.id));
      await ctx.audit(tx, { action: 'recommendation.task_created', targetType: 'recommendation', targetId: rec.id, metadata: { task: task.key } });
      return { key: task.key };
    });
  }),

  /** Run a scan now instead of waiting for the night. Repeated clicks share one queued run. */
  scanNow: adminProcedure.mutation(async ({ ctx }) => {
    await ctx.deps.queues.groupAgent.add('scan', { kind: 'scan', orgId: ctx.orgId }, { jobId: groupAgentScanJobId(ctx.orgId) });
    await ctx.inOrg((tx) => ctx.audit(tx, { action: 'group_agent.scan_requested', targetType: 'org', targetId: ctx.orgId }));
    return { queued: true };
  }),

  /** The latest weekly digest, with its top risks' current state. */
  digest: adminProcedure.query(({ ctx }) =>
    ctx.inOrg(async (tx) => {
      const [run] = await tx
        .select()
        .from(groupAgentRuns)
        .where(and(eq(groupAgentRuns.orgId, ctx.orgId), eq(groupAgentRuns.kind, 'digest')))
        .orderBy(desc(groupAgentRuns.startedAt))
        .limit(1);
      if (!run) return null;
      const p = run.payload as {
        since: string;
        repos: { repoId: string; name: string; score: number; previous: number | null }[];
        topRisks: { id: string; title: string; severity: string; kind: string; repoId: string | null }[];
        newFindings: number;
        resolvedFindings: number;
        openFindings: number;
      };
      const ids = p.topRisks.map((r) => r.id);
      const still = ids.length ? await tx.select({ id: groupAgentFindings.id, resolvedAt: groupAgentFindings.resolvedAt }).from(groupAgentFindings).where(inArray(groupAgentFindings.id, ids)) : [];
      const resolved = new Set(still.filter((s) => s.resolvedAt).map((s) => s.id));
      return { at: run.startedAt, ...p, topRisks: p.topRisks.map((r) => ({ ...r, resolvedSince: resolved.has(r.id) })) };
    }),
  ),

  policies: router({
    get: adminProcedure.query(({ ctx }) =>
      ctx.inOrg(async (tx) => {
        const rows = await tx.select().from(agentPolicies).where(eq(agentPolicies.orgId, ctx.orgId));
        const org = rows.find((r) => r.repoId === null);
        const repoRows = await tx.select({ id: repos.id, fullName: repos.fullName }).from(repos).where(and(eq(repos.orgId, ctx.orgId), isNull(repos.deletedAt))).orderBy(asc(repos.fullName));
        // Who can be a repo's maintainer: active members with push access to it.
        const pushers = await tx
          .select({ repoId: userRepoAccess.repoId, userId: users.id, login: users.githubLogin })
          .from(userRepoAccess)
          .innerJoin(users, eq(users.id, userRepoAccess.userId))
          .innerJoin(orgMembers, and(eq(orgMembers.userId, users.id), eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.status, 'active')))
          .where(and(eq(userRepoAccess.orgId, ctx.orgId), inArray(userRepoAccess.permission, [...WRITE_PERMISSIONS])));
        return {
          enabled: org?.enabled ?? false,
          monthlyBudgetUsd: org?.monthlyBudgetUsd === null || org?.monthlyBudgetUsd === undefined ? null : Number(org.monthlyBudgetUsd),
          weeklyPrCap: org?.weeklyPrCap ?? 5,
          repos: repoRows.map((r) => {
            const p = rows.find((x) => x.repoId === r.id);
            return {
              repoId: r.id,
              name: r.fullName,
              scan: p ? p.enabled : true,
              safetyLevel: p?.safetyLevel ?? 2,
              maintainerUserId: p?.maintainerUserId ?? null,
              candidates: pushers.filter((u) => u.repoId === r.id).map((u) => ({ userId: u.userId, login: u.login })),
            };
          }),
        };
      }),
    ),

    update: adminProcedure
      .input(z.object({ enabled: z.boolean(), monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable(), weeklyPrCap: z.number().int().min(0).max(100) }).partial())
      .mutation(({ ctx, input }) =>
        ctx.inOrg(async (tx) => {
          const values = {
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: input.monthlyBudgetUsd === null ? null : input.monthlyBudgetUsd.toFixed(2) }),
            ...(input.weeklyPrCap === undefined ? {} : { weeklyPrCap: input.weeklyPrCap }),
            updatedBy: ctx.userId,
            updatedAt: new Date(),
          };
          await tx
            .insert(agentPolicies)
            .values({ orgId: ctx.orgId, ...values })
            .onConflictDoUpdate({ target: [agentPolicies.orgId, agentPolicies.repoId], set: values });
          await ctx.audit(tx, { action: 'group_agent.settings_updated', targetType: 'org', targetId: ctx.orgId, metadata: input });
          return { ok: true };
        }),
      ),

    updateRepo: adminProcedure
      .input(z.object({ repoId: z.string().uuid(), scan: z.boolean(), safetyLevel: z.number().int().min(1).max(3), maintainerUserId: z.string().uuid().nullable() }).partial({ scan: true, safetyLevel: true, maintainerUserId: true }))
      .mutation(({ ctx, input }) =>
        ctx.inOrg(async (tx) => {
          const [repo] = await tx.select({ id: repos.id }).from(repos).where(and(eq(repos.id, input.repoId), eq(repos.orgId, ctx.orgId)));
          if (!repo) throw new TRPCError({ code: 'NOT_FOUND', message: 'Repository not found' });
          if (input.maintainerUserId) {
            const [ok] = await tx
              .select({ userId: userRepoAccess.userId })
              .from(userRepoAccess)
              .where(and(eq(userRepoAccess.orgId, ctx.orgId), eq(userRepoAccess.repoId, input.repoId), eq(userRepoAccess.userId, input.maintainerUserId), inArray(userRepoAccess.permission, [...WRITE_PERMISSIONS])));
            if (!ok) throw new TRPCError({ code: 'BAD_REQUEST', message: 'The maintainer needs push access to this repository' });
          }
          const values = {
            ...(input.scan === undefined ? {} : { enabled: input.scan }),
            ...(input.safetyLevel === undefined ? {} : { safetyLevel: input.safetyLevel }),
            ...(input.maintainerUserId === undefined ? {} : { maintainerUserId: input.maintainerUserId }),
            updatedBy: ctx.userId,
            updatedAt: new Date(),
          };
          // A new repo row scans by default, like having no row.
          await tx
            .insert(agentPolicies)
            .values({ orgId: ctx.orgId, repoId: input.repoId, enabled: true, ...values })
            .onConflictDoUpdate({ target: [agentPolicies.orgId, agentPolicies.repoId], set: values });
          await ctx.audit(tx, { action: 'group_agent.repo_settings_updated', targetType: 'repo', targetId: input.repoId, metadata: input });
          return { ok: true };
        }),
      ),
  }),
});
