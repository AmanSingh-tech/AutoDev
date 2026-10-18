import {
  and,
  BOARD_COLUMNS,
  desc,
  eq,
  ilike,
  inArray,
  or,
  schema,
  sql,
  TASK_MODES,
  alias,
  TASK_PRIORITIES,
  type TaskMode,
  type TaskStatus,
  type Tx,
} from '@autodev/db';
import { getBranch, isValidBranchName, newBranchName, userOctokit } from '@autodev/github';
import { LlmBlocked } from '@autodev/llm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Deps } from '../../deps';
import { normalizeScopePath, recordEvent, transition } from '../../services/tasks';
import { orgProcedure, requireRole, roleAtLeast, router } from '../trpc';

const { orgs, pullRequests, repoPolicies, repos, taskEvents, tasks, users } = schema;

const fields = z.object({
  title: z.string().trim().min(1).max(200),
  descriptionMd: z.string().max(20_000).default(''),
  acceptanceCriteriaMd: z.string().max(10_000).default(''),
  priority: z.enum(TASK_PRIORITIES).default('medium'),
  mode: z.enum(TASK_MODES).optional(),
  scopePath: z.string().max(300).nullish(),
  branchMode: z.enum(['new', 'existing']),
  targetBranch: z.string().max(255).nullish(),
  relatedTaskId: z.string().uuid().nullish(),
  extraContext: z.string().max(10_000).nullish(),
  createPrOnCompletion: z.boolean().default(true),
});

const keyInput = z.object({ key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d+$/) });

const PRIORITY_ORDER = sql`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`;

type Ctx = { deps: Deps; orgId: string; userId: string; role: import('@autodev/db').OrgRole; inOrg: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> };

/** Only someone who can push to the repo may create work for it. Uses the 15-minute cache. */
async function assertCanWork(ctx: Ctx, repoId: string, userId = ctx.userId) {
  const writable = await ctx.deps.repoAccess.listWritable(ctx.orgId, userId);
  const repo = writable.find((r) => r.id === repoId);
  if (!repo) throw new TRPCError({ code: 'FORBIDDEN', message: 'You need push access to this repository on GitHub' });
  return repo;
}

/** A repo's locked mode always wins; otherwise the requested mode, the repo default, then the org default. */
async function resolveMode(tx: Tx, orgId: string, repoId: string, requested: TaskMode | undefined): Promise<TaskMode> {
  const [policy] = await tx.select().from(repoPolicies).where(and(eq(repoPolicies.orgId, orgId), eq(repoPolicies.repoId, repoId)));
  if (policy?.lockedMode) {
    if (requested && requested !== policy.lockedMode) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `This repository is locked to the ${policy.lockedMode} mode` });
    }
    return policy.lockedMode;
  }
  if (requested) return requested;
  if (policy?.defaultMode) return policy.defaultMode;
  const [org] = await tx.select({ m: orgs.defaultTaskMode }).from(orgs).where(eq(orgs.id, orgId));
  return org!.m;
}

async function validateBranch(ctx: Ctx, repo: { owner: string; name: string; defaultBranch: string }, branchMode: 'new' | 'existing', targetBranch: string | null | undefined) {
  if (branchMode === 'new') return null;
  const name = targetBranch?.trim();
  if (!name || !isValidBranchName(name)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose an existing branch' });
  // Work always lands through a PR, so the default branch itself is never a target.
  if (name === repo.defaultBranch) throw new TRPCError({ code: 'BAD_REQUEST', message: `AutoDev doesn't push to ${name} directly. Pick a feature branch, or start a new branch.` });
  const found = await ctx.deps.vault.withToken(ctx.userId, (token) => getBranch(userOctokit(ctx.deps.cfg, token), repo.owner, repo.name, name));
  if (!found) throw new TRPCError({ code: 'BAD_REQUEST', message: `Branch "${name}" doesn't exist on GitHub` });
  return name;
}

async function validateRelated(tx: Tx, orgId: string, relatedTaskId: string | null | undefined, selfId?: string) {
  if (!relatedTaskId) return null;
  if (relatedTaskId === selfId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'A task cannot be related to itself' });
  const [t] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.id, relatedTaskId)));
  if (!t) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Related task not found' });
  return t.id;
}

async function loadTask(tx: Tx, orgId: string, key: string) {
  const [t] = await tx.select().from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.key, key)));
  if (!t) throw new TRPCError({ code: 'NOT_FOUND', message: `Task ${key} not found` });
  return t;
}

const canManage = (ctx: Ctx, t: { ownerId: string }) => t.ownerId === ctx.userId || roleAtLeast(ctx.role, 'admin');

/**
 * Draft → queued. Refused up front if the owner has no working LLM key or hit a hard budget,
 * so a task never queues only to fail. The agent worker (A-4) picks up the job.
 */
async function startTask(ctx: Ctx, key: string) {
  const t = await ctx.inOrg((tx) => loadTask(tx, ctx.orgId, key));
  if (!canManage(ctx, t)) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task owner or an admin can start it' });
  await assertCanWork(ctx, t.repoId, t.ownerId);
  try {
    await ctx.deps.gateway.assertRunAllowed(ctx.orgId, t.ownerId);
  } catch (e) {
    if (e instanceof LlmBlocked) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message, cause: e });
    throw e;
  }
  const { task, eventId } = await ctx.inOrg((tx) => transition(tx, t, 'queued', { type: 'user', userId: ctx.userId }));
  await ctx.deps.queues.agent.add('run', { kind: 'run', orgId: ctx.orgId, taskId: t.id }, { jobId: `run-${eventId}` });
  return task;
}

export const tasksRouter = router({
  list: orgProcedure
    .input(
      z
        .object({
          repoId: z.string().uuid().optional(),
          q: z.string().trim().max(200).optional(),
          column: z.enum(BOARD_COLUMNS.map((c) => c.id) as [string, ...string[]]).optional(),
          priority: z.enum(TASK_PRIORITIES).optional(),
          mine: z.boolean().optional(),
          limit: z.number().int().min(1).max(500).default(200),
        })
        .default({}),
    )
    .query(({ ctx, input }) => {
      const statuses = input.column ? (BOARD_COLUMNS.find((c) => c.id === input.column)!.statuses as readonly TaskStatus[]) : null;
      const q = input.q?.replace(/[%_\\]/g, (c) => `\\${c}`);
      return ctx.inOrg((tx) =>
        tx
          .select({
            id: tasks.id,
            key: tasks.key,
            title: tasks.title,
            status: tasks.status,
            priority: tasks.priority,
            mode: tasks.mode,
            branchMode: tasks.branchMode,
            workBranch: tasks.workBranch,
            repoId: tasks.repoId,
            repoName: repos.name,
            ownerId: tasks.ownerId,
            ownerLogin: users.githubLogin,
            ownerAvatar: users.avatarUrl,
            updatedAt: tasks.updatedAt,
          })
          .from(tasks)
          .innerJoin(repos, eq(repos.id, tasks.repoId))
          .innerJoin(users, eq(users.id, tasks.ownerId))
          .where(
            and(
              eq(tasks.orgId, ctx.orgId),
              input.repoId ? eq(tasks.repoId, input.repoId) : undefined,
              statuses ? inArray(tasks.status, [...statuses]) : undefined,
              input.priority ? eq(tasks.priority, input.priority) : undefined,
              input.mine ? eq(tasks.ownerId, ctx.userId) : undefined,
              q ? or(ilike(tasks.title, `%${q}%`), ilike(tasks.key, `%${q}%`)) : undefined,
            ),
          )
          .orderBy(PRIORITY_ORDER, desc(tasks.updatedAt))
          .limit(input.limit),
      );
    }),

  get: orgProcedure.input(keyInput).query(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      const t = await loadTask(tx, ctx.orgId, input.key);
      const owner = alias(users, 'owner');
      const [extra] = await tx
        .select({ repo: { id: repos.id, name: repos.name, fullName: repos.fullName, defaultBranch: repos.defaultBranch }, ownerLogin: owner.githubLogin, ownerAvatar: owner.avatarUrl })
        .from(tasks)
        .innerJoin(repos, eq(repos.id, tasks.repoId))
        .innerJoin(owner, eq(owner.id, tasks.ownerId))
        .where(eq(tasks.id, t.id));
      const [related] = t.relatedTaskId
        ? await tx.select({ key: tasks.key, title: tasks.title, status: tasks.status, summaryMd: tasks.summaryMd }).from(tasks).where(eq(tasks.id, t.relatedTaskId))
        : [];
      const events = await tx
        .select({ id: taskEvents.id, type: taskEvents.type, actorType: taskEvents.actorType, actorLogin: users.githubLogin, fromStatus: taskEvents.fromStatus, toStatus: taskEvents.toStatus, payload: taskEvents.payload, createdAt: taskEvents.createdAt })
        .from(taskEvents)
        .leftJoin(users, eq(users.id, taskEvents.actorUserId))
        .where(eq(taskEvents.taskId, t.id))
        .orderBy(desc(taskEvents.createdAt))
        .limit(100);
      const manage = canManage(ctx, t);
      const prs = await tx
        .select({ number: pullRequests.number, url: pullRequests.url, state: pullRequests.state, baseBranch: pullRequests.baseBranch, createdBy: pullRequests.createdBy, mergedAt: pullRequests.mergedAt, createdAt: pullRequests.createdAt })
        .from(pullRequests)
        .where(eq(pullRequests.taskId, t.id))
        .orderBy(desc(pullRequests.createdAt));
      const lastFail = events.find((e) => e.toStatus === 'failed');
      return {
        ...t,
        ...extra!,
        related: related ?? null,
        events,
        pullRequests: prs,
        failure: t.status === 'failed' && lastFail ? (lastFail.payload as { reason?: string; message?: string; kind?: string }) : null,
        can: {
          createPr: manage && t.status === 'pushed' && !prs.some((p) => p.state === 'open'),
          retryPush: manage && t.status === 'failed' && (lastFail?.payload as { reason?: string } | undefined)?.reason === 'push_failed',
          edit: manage && t.status === 'draft',
          start: manage && (t.status === 'draft' || t.status === 'failed'),
          unqueue: manage && t.status === 'queued',
          cancel: manage && !['pushed', 'pr_open', 'resolved', 'rejected', 'failed', 'cancelled'].includes(t.status),
        },
      };
    }),
  ),

  create: requireRole('developer')
    .input(fields.extend({ repoId: z.string().uuid(), start: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const repo = await assertCanWork(ctx, input.repoId);
      const scopePath = normalizeScopePath(input.scopePath);
      const targetBranch = await validateBranch(ctx, repo, input.branchMode, input.targetBranch);

      const created = await ctx.inOrg(async (tx) => {
        const mode = await resolveMode(tx, ctx.orgId, repo.id, input.mode);
        const relatedTaskId = await validateRelated(tx, ctx.orgId, input.relatedTaskId);
        // Row lock on the org serializes key minting, so numbers are gap-free and unique.
        const [seq] = await tx
          .update(orgs)
          .set({ taskSeq: sql`${orgs.taskSeq} + 1` })
          .where(eq(orgs.id, ctx.orgId))
          .returning({ n: orgs.taskSeq, prefix: orgs.taskKeyPrefix });
        const key = `${seq!.prefix}-${seq!.n}`;
        const [t] = await tx
          .insert(tasks)
          .values({
            orgId: ctx.orgId,
            repoId: repo.id,
            number: seq!.n,
            key,
            title: input.title,
            descriptionMd: input.descriptionMd,
            acceptanceCriteriaMd: input.acceptanceCriteriaMd,
            priority: input.priority,
            mode,
            scopePath,
            branchMode: input.branchMode,
            targetBranch,
            workBranch: targetBranch ?? newBranchName(key, input.title),
            relatedTaskId,
            extraContext: input.extraContext?.trim() || null,
            createPrOnCompletion: input.createPrOnCompletion,
            createdBy: ctx.userId,
            ownerId: ctx.userId,
          })
          .returning();
        await recordEvent(tx, { orgId: ctx.orgId, taskId: t!.id, actor: { type: 'user', userId: ctx.userId }, type: 'created', payload: { mode, branchMode: input.branchMode } });
        return t!;
      });
      return input.start ? startTask(ctx, created.key) : created;
    }),

  /** Edits are allowed while the task is a draft; once queued the agent may already be reading it. */
  update: requireRole('developer')
    .input(keyInput.merge(fields.partial()))
    .mutation(async ({ ctx, input }) => {
      const { key, ...patch } = input;
      const t = await ctx.inOrg((tx) => loadTask(tx, ctx.orgId, key));
      if (!canManage(ctx, t)) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task owner or an admin can edit it' });
      if (t.status !== 'draft') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only draft tasks can be edited. Move it back to draft first.' });

      const [repo] = await ctx.inOrg((tx) => tx.select().from(repos).where(eq(repos.id, t.repoId)));
      const branchMode = patch.branchMode ?? t.branchMode;
      const targetBranch =
        patch.branchMode !== undefined || patch.targetBranch !== undefined
          ? await validateBranch(ctx, repo!, branchMode, patch.targetBranch ?? t.targetBranch)
          : t.targetBranch;
      const scopePath = patch.scopePath !== undefined ? normalizeScopePath(patch.scopePath) : t.scopePath;
      const title = patch.title ?? t.title;

      return ctx.inOrg(async (tx) => {
        const mode = patch.mode !== undefined ? await resolveMode(tx, ctx.orgId, t.repoId, patch.mode) : t.mode;
        const relatedTaskId = patch.relatedTaskId !== undefined ? await validateRelated(tx, ctx.orgId, patch.relatedTaskId, t.id) : t.relatedTaskId;
        const [updated] = await tx
          .update(tasks)
          .set({
            title,
            descriptionMd: patch.descriptionMd ?? t.descriptionMd,
            acceptanceCriteriaMd: patch.acceptanceCriteriaMd ?? t.acceptanceCriteriaMd,
            priority: patch.priority ?? t.priority,
            mode,
            scopePath,
            branchMode,
            targetBranch,
            workBranch: targetBranch ?? newBranchName(t.key, title),
            relatedTaskId,
            extraContext: patch.extraContext !== undefined ? patch.extraContext?.trim() || null : t.extraContext,
            createPrOnCompletion: patch.createPrOnCompletion ?? t.createPrOnCompletion,
          })
          .where(and(eq(tasks.id, t.id), eq(tasks.status, 'draft')))
          .returning();
        if (!updated) throw new TRPCError({ code: 'CONFLICT', message: 'The task changed in the meantime. Refresh and try again.' });
        await recordEvent(tx, { orgId: ctx.orgId, taskId: t.id, actor: { type: 'user', userId: ctx.userId }, type: 'edited', payload: { fields: Object.keys(patch) } });
        return updated;
      });
    }),

  start: requireRole('developer').input(keyInput).mutation(({ ctx, input }) => startTask(ctx, input.key)),

  unqueue: requireRole('developer')
    .input(keyInput)
    .mutation(({ ctx, input }) =>
      ctx.inOrg(async (tx) => {
        const t = await loadTask(tx, ctx.orgId, input.key);
        if (!canManage(ctx, t)) throw new TRPCError({ code: 'FORBIDDEN' });
        return (await transition(tx, t, 'draft', { type: 'user', userId: ctx.userId })).task;
      }),
    ),

  cancel: requireRole('developer')
    .input(keyInput.extend({ reason: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const task = await ctx.inOrg(async (tx) => {
        const t = await loadTask(tx, ctx.orgId, input.key);
        if (!canManage(ctx, t)) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task owner or an admin can cancel it' });
        return (await transition(tx, t, 'cancelled', { type: 'user', userId: ctx.userId }, input.reason ? { reason: input.reason } : {})).task;
      });
      // Stop any test run on a builder.
      await ctx.deps.builderJobs.cancelForTask(task.id);
      return task;
    }),
});
