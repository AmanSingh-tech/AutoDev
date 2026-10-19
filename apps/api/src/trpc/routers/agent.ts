import { GitHubRepoReader, PgOverlayStore, PublishError, VirtualWorkspace, WorkspaceError } from '@autodev/agent';
import { and, asc, desc, eq, isNull, schema, type DocumentKind } from '@autodev/db';
import { userOctokit } from '@autodev/github';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { enqueueAgent, resumeStatusOf } from '../../services/agent-control';
import { transition } from '../../services/tasks';
import { orgProcedure, requireRole, roleAtLeast, router } from '../trpc';

const { agentRuns, agentSteps, builderJobs, builders, repos, taskDocuments, taskQuestions, tasks, users, workspaceFiles, workspaces } = schema;

const keyInput = z.object({ key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d+$/) });

async function loadTask(tx: import('@autodev/db').Tx, orgId: string, key: string) {
  const [t] = await tx.select().from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.key, key)));
  if (!t) throw new TRPCError({ code: 'NOT_FOUND', message: `Task ${key} not found` });
  return t;
}

const REVIEW_STATUS: Record<DocumentKind, 'awaiting_plan_approval' | 'awaiting_lld_approval'> = { plan: 'awaiting_plan_approval', lld: 'awaiting_lld_approval' };
const REWORK_STATUS: Record<DocumentKind, 'planning' | 'designing'> = { plan: 'planning', lld: 'designing' };

export const agentRouter = router({
  /** Every plan and LLD version, newest first, plus the open question, if any. */
  documents: orgProcedure.input(keyInput).query(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      const t = await loadTask(tx, ctx.orgId, input.key);
      const docs = await tx
        .select({ id: taskDocuments.id, kind: taskDocuments.kind, version: taskDocuments.version, contentMd: taskDocuments.contentMd, status: taskDocuments.status, comment: taskDocuments.comment, reviewedAt: taskDocuments.reviewedAt, reviewerLogin: users.githubLogin, createdAt: taskDocuments.createdAt })
        .from(taskDocuments)
        .leftJoin(users, eq(users.id, taskDocuments.reviewerId))
        .where(eq(taskDocuments.taskId, t.id))
        .orderBy(desc(taskDocuments.version));
      const [question] = await tx.select().from(taskQuestions).where(and(eq(taskQuestions.taskId, t.id), isNull(taskQuestions.answeredAt)));
      return { docs, question: question ?? null };
    }),
  ),

  /** Approve, request changes (v2, v3…), or reject the pending plan or LLD. */
  review: requireRole('developer')
    .input(
      keyInput.extend({
        kind: z.enum(['plan', 'lld']),
        version: z.number().int().positive(),
        decision: z.enum(['approve', 'request_changes', 'reject']),
        comment: z.string().trim().max(10_000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.decision === 'request_changes' && !input.comment) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Say what should change' });
      const res = await ctx.inOrg(async (tx) => {
        const t = await loadTask(tx, ctx.orgId, input.key);
        if (t.ownerId !== ctx.userId && !roleAtLeast(ctx.role, 'admin')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task owner or an admin can review' });
        if (t.status !== REVIEW_STATUS[input.kind]) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Nothing is waiting for review' });
        const [doc] = await tx
          .update(taskDocuments)
          .set({
            status: input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'changes_requested',
            reviewerId: ctx.userId,
            comment: input.comment ?? null,
            reviewedAt: new Date(),
          })
          .where(and(eq(taskDocuments.taskId, t.id), eq(taskDocuments.kind, input.kind), eq(taskDocuments.version, input.version), eq(taskDocuments.status, 'pending_review')))
          .returning();
        if (!doc) throw new TRPCError({ code: 'CONFLICT', message: 'That version is no longer pending. Refresh to see the latest.' });

        const to =
          input.decision === 'reject' ? 'rejected' : input.decision === 'request_changes' ? REWORK_STATUS[input.kind] : input.kind === 'plan' && t.mode === 'plan_lld' ? 'designing' : 'coding';
        const { task, eventId } = await transition(tx, t, to, { type: 'user', userId: ctx.userId }, { kind: input.kind, version: input.version, decision: input.decision });
        await ctx.audit(tx, {
          action: `doc.${input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'changes_requested'}`,
          targetType: 'task_document',
          targetId: doc.id,
          metadata: { task: t.key, kind: input.kind, version: input.version },
        });
        return { task, eventId };
      });
      if (res.task.status !== 'rejected') await enqueueAgent(ctx.deps, ctx.orgId, res.task.id, res.eventId);
      return res.task;
    }),

  /** Answer the agent's question. Deviation requests also need approve: true or false. */
  answer: requireRole('developer')
    .input(keyInput.extend({ questionId: z.string().uuid(), answer: z.string().trim().min(1).max(10_000), approve: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const res = await ctx.inOrg(async (tx) => {
        const t = await loadTask(tx, ctx.orgId, input.key);
        if (t.ownerId !== ctx.userId && !roleAtLeast(ctx.role, 'admin')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task owner or an admin can answer' });
        if (t.status !== 'needs_input') throw new TRPCError({ code: 'BAD_REQUEST', message: 'The agent is not waiting for an answer' });
        const [q] = await tx.select().from(taskQuestions).where(and(eq(taskQuestions.id, input.questionId), eq(taskQuestions.taskId, t.id), isNull(taskQuestions.answeredAt)));
        if (!q) throw new TRPCError({ code: 'CONFLICT', message: 'That question was already answered' });
        if (q.kind === 'deviation' && input.approve === undefined) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Allow or deny the change first' });
        await tx
          .update(taskQuestions)
          .set({ answerMd: input.answer, answeredBy: ctx.userId, answeredAt: new Date(), approved: q.kind === 'deviation' ? input.approve! : null })
          .where(eq(taskQuestions.id, q.id));
        const to = (await resumeStatusOf(tx, t.id)) ?? 'planning';
        if (q.kind === 'deviation') {
          await ctx.audit(tx, { action: input.approve ? 'deviation.approved' : 'deviation.denied', targetType: 'task', targetId: t.id, metadata: { task: t.key, paths: q.paths } });
        }
        return transition(tx, t, to, { type: 'user', userId: ctx.userId }, { questionId: q.id });
      });
      await enqueueAgent(ctx.deps, ctx.orgId, res.task.id, res.eventId);
      return res.task;
    }),

  /** blocked_on_key → back to work, once the owner has a usable key. */
  resume: requireRole('developer')
    .input(keyInput)
    .mutation(async ({ ctx, input }) => {
      const t = await ctx.inOrg((tx) => loadTask(tx, ctx.orgId, input.key));
      if (t.ownerId !== ctx.userId && !roleAtLeast(ctx.role, 'admin')) throw new TRPCError({ code: 'FORBIDDEN' });
      if (t.status !== 'blocked_on_key') throw new TRPCError({ code: 'BAD_REQUEST', message: 'The task is not blocked' });
      const policy = await ctx.deps.gateway.policy(ctx.orgId, 'agent');
      if (!(await ctx.deps.gateway.resolveCredential(ctx.orgId, t.ownerId, policy.provider))) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'There is still no working LLM key. An admin needs to add one.' });
      }
      const to = await ctx.inOrg((tx) => resumeStatusOf(tx, t.id));
      if (!to) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Nothing to resume' });
      const res = await ctx.inOrg((tx) => transition(tx, t, to, { type: 'user', userId: ctx.userId }, { reason: 'manual_resume' }));
      await enqueueAgent(ctx.deps, ctx.orgId, t.id, res.eventId);
      return res.task;
    }),

  /** What the agent did: runs and their steps (truncated; the full transcript stays server-side). */
  activity: orgProcedure.input(keyInput).query(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      const t = await loadTask(tx, ctx.orgId, input.key);
      const runs = await tx
        .select({ id: agentRuns.id, phase: agentRuns.phase, status: agentRuns.status, turns: agentRuns.turns, inputTokens: agentRuns.inputTokens, outputTokens: agentRuns.outputTokens, costUsd: agentRuns.costUsd, error: agentRuns.error, startedAt: agentRuns.startedAt, endedAt: agentRuns.endedAt })
        .from(agentRuns)
        .where(eq(agentRuns.taskId, t.id))
        .orderBy(desc(agentRuns.startedAt));
      const steps = await tx
        .select({ id: agentSteps.id, runId: agentSteps.agentRunId, seq: agentSteps.seq, kind: agentSteps.kind, toolName: agentSteps.toolName, input: agentSteps.input, output: agentSteps.output, isError: agentSteps.isError, durationMs: agentSteps.durationMs, createdAt: agentSteps.createdAt })
        .from(agentSteps)
        .where(eq(agentSteps.taskId, t.id))
        .orderBy(desc(agentSteps.createdAt))
        .limit(300);
      return { runs, steps };
    }),
  ),

  /** Test runs on builders for this task, newest first. */
  testJobs: orgProcedure.input(keyInput).query(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      const t = await loadTask(tx, ctx.orgId, input.key);
      return tx
        .select({
          id: builderJobs.id,
          status: builderJobs.status,
          consent: builderJobs.consent,
          configChanged: builderJobs.configChanged,
          config: builderJobs.configSnapshot,
          configError: builderJobs.configError,
          final: builderJobs.final,
          fixCycle: builderJobs.fixCycle,
          builderName: builders.name,
          docker: builderJobs.docker,
          exitCode: builderJobs.exitCode,
          failedStep: builderJobs.failedStep,
          failedTests: builderJobs.failedTests,
          durationMs: builderJobs.durationMs,
          error: builderJobs.error,
          queuedAt: builderJobs.queuedAt,
          startedAt: builderJobs.startedAt,
          finishedAt: builderJobs.finishedAt,
        })
        .from(builderJobs)
        .leftJoin(builders, eq(builders.id, builderJobs.builderId))
        .where(eq(builderJobs.taskId, t.id))
        .orderBy(desc(builderJobs.queuedAt));
    }),
  ),

  /** Live while running (streamed through Redis), then the saved log. */
  jobLog: orgProcedure.input(z.object({ jobId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const [job] = await ctx.inOrg((tx) => tx.select({ status: builderJobs.status, logHash: builderJobs.logHash }).from(builderJobs).where(and(eq(builderJobs.orgId, ctx.orgId), eq(builderJobs.id, input.jobId))));
    if (!job) throw new TRPCError({ code: 'NOT_FOUND' });
    const text = job.logHash ? ((await ctx.deps.blobs.get(job.logHash))?.toString('utf8') ?? '') : await ctx.deps.liveLogs(input.jobId);
    const MAX = 2 * 1024 * 1024;
    return { status: job.status, text: text.length > MAX ? `[showing the last 2 MB]\n${text.slice(-MAX)}` : text, live: !job.logHash };
  }),

  /** The patch edits .autodev.yml: the owner allows or refuses running it. */
  consent: requireRole('developer')
    .input(keyInput.extend({ jobId: z.string().uuid(), allow: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const t = await ctx.inOrg((tx) => loadTask(tx, ctx.orgId, input.key));
      if (t.ownerId !== ctx.userId && !roleAtLeast(ctx.role, 'admin')) throw new TRPCError({ code: 'FORBIDDEN' });
      const [job] = await ctx.deps.sys
        .update(builderJobs)
        .set(
          input.allow
            ? { consent: 'granted' }
            : {
                consent: 'denied',
                status: 'failed',
                failedStep: 'system',
                finishedAt: new Date(),
                logTail: 'The task owner did not allow running tests with a modified .autodev.yml. Revert your changes to .autodev.yml (it is not part of this task) and finish again.',
              },
        )
        .where(and(eq(builderJobs.orgId, ctx.orgId), eq(builderJobs.id, input.jobId), eq(builderJobs.taskId, t.id), eq(builderJobs.consent, 'pending')))
        .returning();
      if (!job) throw new TRPCError({ code: 'CONFLICT', message: 'Nothing is waiting for consent' });
      await ctx.inOrg((tx) => ctx.audit(tx, { action: input.allow ? 'builder_job.consent_granted' : 'builder_job.consent_denied', targetType: 'builder_job', targetId: job.id, metadata: { task: t.key } }));
      if (input.allow) await ctx.deps.builderJobs.dispatch(job.id);
      else {
        // Hand the refusal to the agent like a failed run.
        const res = await ctx.inOrg((tx) => transition(tx, t, 'testing', { type: 'user', userId: ctx.userId }, { jobId: job.id, consent: 'denied' }));
        await enqueueAgent(ctx.deps, ctx.orgId, t.id, res.eventId);
      }
      return { ok: true };
    }),

  /** The "Create PR" button, for tasks pushed with create_pr_on_completion off. Opened as the clicking user. */
  createPr: requireRole('developer')
    .input(keyInput)
    .mutation(async ({ ctx, input }) => {
      const t = await ctx.inOrg((tx) => loadTask(tx, ctx.orgId, input.key));
      if (t.ownerId !== ctx.userId && !roleAtLeast(ctx.role, 'admin')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task owner or an admin can open its PR' });
      if (t.status !== 'pushed') throw new TRPCError({ code: 'BAD_REQUEST', message: 'The task has nothing pushed without a PR' });
      try {
        return await ctx.deps.publisher.openOrUpdatePr(t.id, { actorUserId: ctx.userId, createdBy: 'user' });
      } catch (e) {
        if (e instanceof PublishError) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message });
        throw e;
      }
    }),

  /** After a failed push (permissions, branch protection, conflict, expired session): try just the push again. */
  retryPush: requireRole('developer')
    .input(keyInput)
    .mutation(async ({ ctx, input }) => {
      const t = await ctx.inOrg((tx) => loadTask(tx, ctx.orgId, input.key));
      if (t.ownerId !== ctx.userId && !roleAtLeast(ctx.role, 'admin')) throw new TRPCError({ code: 'FORBIDDEN' });
      const [last] = await ctx.inOrg((tx) =>
        tx.select({ payload: schema.taskEvents.payload }).from(schema.taskEvents).where(and(eq(schema.taskEvents.taskId, t.id), eq(schema.taskEvents.toStatus, 'failed'))).orderBy(desc(schema.taskEvents.createdAt)).limit(1),
      );
      if (t.status !== 'failed' || (last?.payload as { reason?: string } | undefined)?.reason !== 'push_failed') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only a failed push can be retried' });
      }
      await ctx.inOrg((tx) => transition(tx, t, 'testing', { type: 'user', userId: ctx.userId }, { reason: 'retry_push' }));
      const result = await ctx.deps.publisher.publishOrFail(t.id);
      return { result };
    }),

  /** Files the agent changed so far. */
  changes: orgProcedure.input(keyInput).query(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      const t = await loadTask(tx, ctx.orgId, input.key);
      const [ws] = await tx.select().from(workspaces).where(eq(workspaces.taskId, t.id));
      if (!ws) return { baseSha: null, revision: 0, files: [] };
      const files = await tx.select({ path: workspaceFiles.path, op: workspaceFiles.op }).from(workspaceFiles).where(eq(workspaceFiles.workspaceId, ws.id)).orderBy(asc(workspaceFiles.path));
      return { baseSha: ws.baseSha, revision: ws.revision, files };
    }),
  ),

  /** Before/after of one changed file for the diff view. The base is read with the caller's own GitHub token. */
  fileDiff: orgProcedure.input(keyInput.extend({ path: z.string().min(1).max(500) })).query(async ({ ctx, input }) => {
    const { t, ws, repo } = await ctx.inOrg(async (tx) => {
      const t = await loadTask(tx, ctx.orgId, input.key);
      const [ws] = await tx.select().from(workspaces).where(eq(workspaces.taskId, t.id));
      const [repo] = await tx.select().from(repos).where(eq(repos.id, t.repoId));
      return { t, ws, repo };
    });
    if (!ws || !repo) throw new TRPCError({ code: 'NOT_FOUND', message: 'No changes yet' });
    const reader = new GitHubRepoReader({
      repoId: repo.id,
      owner: repo.owner,
      name: repo.name,
      baseSha: ws.baseSha,
      cache: ctx.deps.cache,
      withClient: (fn) => ctx.deps.vault.withToken(ctx.userId, (tok) => fn(userOctokit(ctx.deps.cfg, tok))),
    });
    const view = new VirtualWorkspace(reader, new PgOverlayStore(ctx.deps.sys, ws.id, t.orgId), { scope: '' });
    try {
      return await view.fileVersions(input.path);
    } catch (e) {
      if (e instanceof WorkspaceError) throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
      throw e;
    }
  }),
});
