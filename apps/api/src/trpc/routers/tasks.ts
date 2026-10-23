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
import { buildSourceContext, latestPr, readSourceChange } from '@autodev/agent';
import { assertCanPush, getBranch, isValidBranchName, newBranchName, PushNotAllowed, userOctokit } from '@autodev/github';
import { billingState } from '@autodev/billing';
import { LlmBlocked } from '@autodev/llm';
import { PROMPT_SCORE_VERSION, scorePrompt, type PromptDraft } from '@autodev/protocol';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Deps } from '../../deps';
import { normalizeScopePath, recordEvent, transition } from '../../services/tasks';
import { orgProcedure, requireRole, roleAtLeast, router } from '../trpc';
import { linkedTargets } from './repo-links';

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

/** Finished, pushed work: what "Apply to linked repo" can port. */
const PORTABLE = new Set<TaskStatus>(['pushed', 'pr_open', 'resolved']);

const keyInput = z.object({ key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d+$/) });

const PRIORITY_ORDER = sql`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`;

export type Ctx = { deps: Deps; orgId: string; userId: string; role: import('@autodev/db').OrgRole; inOrg: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> };

/** The prompt guide's rule-based score (B-1), the same one the form shows while typing. */
function promptScoreFields(d: PromptDraft) {
  const { score, flags } = scorePrompt(d);
  return { promptScore: score, promptScoreDetails: { version: PROMPT_SCORE_VERSION, flags }, promptCheckedAt: new Date() };
}

/** Only someone who can push to the repo may create work for it. Uses the 15-minute cache. */
export async function assertCanWork(ctx: Ctx, repoId: string, userId = ctx.userId) {
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
export type NewTask = z.infer<typeof fields> & { scopePath: string | null; targetBranch: string | null; relatedTaskId: string | null; sourceTaskId?: string; sourceContextMd?: string };

/** Mints the next key and inserts a draft task owned by the caller. Inputs are already validated. */
export async function insertTask(tx: Tx, ctx: Ctx, repoId: string, input: NewTask) {
  const mode = await resolveMode(tx, ctx.orgId, repoId, input.mode);
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
      repoId,
      number: seq!.n,
      key,
      title: input.title,
      descriptionMd: input.descriptionMd,
      acceptanceCriteriaMd: input.acceptanceCriteriaMd,
      priority: input.priority,
      mode,
      scopePath: input.scopePath,
      branchMode: input.branchMode,
      targetBranch: input.targetBranch,
      workBranch: input.targetBranch ?? newBranchName(key, input.title),
      relatedTaskId: input.relatedTaskId,
      sourceTaskId: input.sourceTaskId ?? null,
      sourceContextMd: input.sourceContextMd ?? null,
      extraContext: input.extraContext?.trim() || null,
      createPrOnCompletion: input.createPrOnCompletion,
      createdBy: ctx.userId,
      ownerId: ctx.userId,
      ...promptScoreFields({ ...input, scopePath: input.scopePath }),
    })
    .returning();
  await recordEvent(tx, { orgId: ctx.orgId, taskId: t!.id, actor: { type: 'user', userId: ctx.userId }, type: 'created', payload: { mode, branchMode: input.branchMode, ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}) } });
  return t!;
}

async function startTask(ctx: Ctx, key: string) {
  const t = await ctx.inOrg((tx) => loadTask(tx, ctx.orgId, key));
  if (!canManage(ctx, t)) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task owner or an admin can start it' });
  // Billing (B-6): a lapsed trial or plan stops new AI work; nothing else changes.
  const billing = await billingState(ctx.deps.sys, ctx.deps.billing.cfg, ctx.orgId);
  if (!billing.canRun) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: billing.blockedReason ?? 'The plan is not active.' });
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
      const [source] = t.sourceTaskId
        ? await tx.select({ key: tasks.key, title: tasks.title, status: tasks.status, repoFullName: repos.fullName, repoName: repos.name }).from(tasks).innerJoin(repos, eq(repos.id, tasks.repoId)).where(eq(tasks.id, t.sourceTaskId))
        : [];
      const ports = await tx
        .select({ key: tasks.key, title: tasks.title, status: tasks.status, repoFullName: repos.fullName, repoName: repos.name })
        .from(tasks)
        .innerJoin(repos, eq(repos.id, tasks.repoId))
        .where(eq(tasks.sourceTaskId, t.id))
        .orderBy(tasks.createdAt);
      const targets = PORTABLE.has(t.status) && roleAtLeast(ctx.role, 'developer') ? await linkedTargets(tx, ctx.orgId, t.repoId) : [];
      return {
        ...t,
        ...extra!,
        related: related ?? null,
        source: source ?? null,
        ports,
        linkedTargets: targets.map((l) => l.repo),
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
        const relatedTaskId = await validateRelated(tx, ctx.orgId, input.relatedTaskId);
        return insertTask(tx, ctx, repo.id, { ...input, scopePath, targetBranch, relatedTaskId });
      });
      return input.start ? startTask(ctx, created.key) : created;
    }),

  /**
   * Cross-repo sync (B-3): a draft task in a linked repo that ports this task's change. The change
   * (pushed commits, or the agent's work) is read now with the caller's access and frozen on the new
   * task, with the link's mapping notes. Needs push access to the target, checked live.
   */
  applyToLinked: requireRole('developer')
    .input(keyInput.extend({ targetRepoId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // First, so the caller's access rows (which RLS reads for links) are current.
      const target = await assertCanWork(ctx, input.targetRepoId);
      const { source, sourceRepo, link } = await ctx.inOrg(async (tx) => {
        const source = await loadTask(tx, ctx.orgId, input.key);
        if (!PORTABLE.has(source.status)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only pushed work can be applied to a linked repository' });
        const link = (await linkedTargets(tx, ctx.orgId, source.repoId)).find((l) => l.repo.id === input.targetRepoId);
        if (!link) throw new TRPCError({ code: 'BAD_REQUEST', message: 'That repository is not linked to this one' });
        const [sourceRepo] = await tx.select().from(repos).where(eq(repos.id, source.repoId));
        return { source, sourceRepo: sourceRepo!, link };
      });
      try {
        await ctx.deps.vault.withToken(ctx.userId, (tok) => assertCanPush(userOctokit(ctx.deps.cfg, tok), target.owner, target.name));
      } catch (e) {
        if (e instanceof PushNotAllowed) throw new TRPCError({ code: 'FORBIDDEN', message: e.message });
        throw e;
      }
      const change = await readSourceChange(ctx.deps, ctx.userId, source);
      if (!change) throw new TRPCError({ code: 'BAD_REQUEST', message: `${source.key} has no changes to apply` });
      const [org] = await ctx.deps.sys.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, ctx.orgId));
      const contextMd = buildSourceContext({
        source: { key: source.key, title: source.title, url: `${ctx.deps.env.WEB_URL}/o/${org!.slug}/tasks/${source.key}`, repoFullName: sourceRepo.fullName, descriptionMd: source.descriptionMd, summaryMd: source.summaryMd },
        pr: await latestPr(ctx.deps.sys, source.id),
        mappingNotesMd: link.mappingNotesMd,
        change,
      });
      return ctx.inOrg(async (tx) => {
        const port = await insertTask(tx, ctx, target.id, {
          title: `Port ${source.key}: ${source.title}`.slice(0, 200),
          descriptionMd: `Bring the change from ${source.key} in \`${sourceRepo.fullName}\` to this repository.\n\n${source.descriptionMd}`.slice(0, 20_000),
          acceptanceCriteriaMd: source.acceptanceCriteriaMd,
          priority: source.priority,
          scopePath: null,
          branchMode: 'new',
          targetBranch: null,
          relatedTaskId: null,
          createPrOnCompletion: source.createPrOnCompletion,
          sourceTaskId: source.id,
          sourceContextMd: contextMd,
        });
        await recordEvent(tx, { orgId: ctx.orgId, taskId: source.id, actor: { type: 'user', userId: ctx.userId }, type: 'ported', payload: { portKey: port.key, repo: target.fullName } });
        await ctx.audit(tx, { action: 'task.applied_to_linked', targetType: 'task', targetId: source.id, metadata: { port: port.key, target: target.fullName, from: change.from } });
        return port;
      });
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
        const descriptionMd = patch.descriptionMd ?? t.descriptionMd;
        const acceptanceCriteriaMd = patch.acceptanceCriteriaMd ?? t.acceptanceCriteriaMd;
        const extraContext = patch.extraContext !== undefined ? patch.extraContext?.trim() || null : t.extraContext;
        const [updated] = await tx
          .update(tasks)
          .set({
            title,
            descriptionMd,
            acceptanceCriteriaMd,
            priority: patch.priority ?? t.priority,
            mode,
            scopePath,
            branchMode,
            targetBranch,
            workBranch: targetBranch ?? newBranchName(t.key, title),
            relatedTaskId,
            extraContext,
            createPrOnCompletion: patch.createPrOnCompletion ?? t.createPrOnCompletion,
            ...promptScoreFields({ title, descriptionMd, acceptanceCriteriaMd, extraContext, scopePath }),
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
