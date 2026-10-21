import { and, desc, eq, inArray, schema, sql, transitionTask, type SystemDb } from '@autodev/db';
import {
  assertCanPush,
  commitToBranch,
  createPr,
  findOpenPr,
  getPr,
  GitHubReauthRequired,
  PushConflict,
  PushNotAllowed,
  updatePrBody,
  userOctokit,
  type GitHubConfig,
  type KvCache,
  type TokenVault,
} from '@autodev/github';
import { DEFAULT_DOCKER_IMAGE, type AutodevConfig } from '@autodev/protocol';
import { addPortedTo, latestPr, portedToLine } from './cross-repo';
import { PgOverlayStore } from './overlay';
import { appendToBody, buildPrBody, buildUpdateSection, type PrContext } from './pr-body';
import { GitHubRepoReader } from './repo-reader';

const { auditLog, builderJobs, builders, notifications, orgs, pullRequests, repos, taskDocuments, taskEvents, tasks, tokenUsage, users, workspaces } = schema;

type Task = typeof tasks.$inferSelect;
export type PublishFailure = 'not_allowed' | 'conflict' | 'reauth';

/** A push or PR couldn't be done; the task fails with this message and can retry the push. */
export class PublishError extends Error {
  override name = 'PublishError';
  constructor(
    readonly reason: PublishFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Pushes a task's tested change with the owner's GitHub token (live permission check first) and
 * opens or updates its PR. Every GitHub write is done as a person, never as the App.
 */
export class Publisher {
  constructor(private readonly deps: { sys: SystemDb; vault: TokenVault; cfg: GitHubConfig; cache: KvCache; webUrl: string }) {}

  /**
   * publish(), with user-fixable failures recorded instead of thrown: a task in testing fails with
   * reason push_failed (retryable); a pushed task keeps its status and gets a pr.failed event.
   */
  async publishOrFail(taskId: string): Promise<string> {
    try {
      const res = await this.publish(taskId);
      return res.prUrl ? 'published:pr' : 'published:branch';
    } catch (e) {
      if (!(e instanceof PublishError)) throw e;
      const cur = await this.task(taskId);
      if (cur.status === 'testing') await transitionTask(this.deps.sys, cur, 'failed', { type: 'agent', userId: null }, { reason: 'push_failed', kind: e.reason, message: e.message });
      else await this.deps.sys.insert(taskEvents).values({ orgId: cur.orgId, taskId: cur.id, actorType: 'agent', type: 'pr.failed', payload: { kind: e.reason, message: e.message } });
      await this.notify(cur, 'push.failed', `Couldn't push ${cur.key}`, e.message);
      return `push_failed:${e.reason}`;
    }
  }

  /** testing → pushed (→ pr_open). Throws PublishError for anything the user has to fix. */
  async publish(taskId: string): Promise<{ commitSha: string; prUrl: string | null }> {
    const { sys } = this.deps;
    const task = await this.task(taskId);
    const [repo] = await sys.select().from(repos).where(eq(repos.id, task.repoId));
    const [ws] = await sys.select().from(workspaces).where(eq(workspaces.taskId, task.id));
    if (!repo || !ws) throw new Error(`task ${task.key} has nothing to push`);
    const overlay = await new PgOverlayStore(sys, ws.id, task.orgId).list();
    if (!overlay.length) throw new PublishError('conflict', 'There are no changes to push.');

    const commitSha = await this.asUser(task.ownerId, async (gh) => {
      await assertCanPush(gh, repo.owner, repo.name);
      const reader = new GitHubRepoReader({ repoId: repo.id, owner: repo.owner, name: repo.name, baseSha: ws.baseSha, cache: this.deps.cache, withClient: (fn) => fn(gh) });
      const modes = new Map((await reader.tree()).entries.map((e) => [e.path, e.mode]));
      const { commitSha } = await commitToBranch(gh, {
        owner: repo.owner,
        repo: repo.name,
        branch: task.workBranch,
        baseSha: ws.baseSha,
        message: commitMessage(task, this.taskUrl(await this.orgSlug(task.orgId), task.key)),
        changes: overlay.map((o) => ({ path: o.path, op: o.op, content: o.content, ...(modes.get(o.path) ? { mode: modes.get(o.path)! } : {}) })),
      });
      return commitSha;
    });

    await sys.transaction(async (tx) => {
      await tx.update(tasks).set({ lastPushedSha: commitSha, lastPushedAt: new Date(), staleNotifiedAt: null }).where(eq(tasks.id, task.id));
      await transitionTask(tx, task, 'pushed', { type: 'agent', userId: null }, { sha: commitSha, branch: task.workBranch });
      await tx.insert(taskEvents).values({ orgId: task.orgId, taskId: task.id, actorType: 'agent', actorUserId: task.ownerId, type: 'branch.pushed', payload: { sha: commitSha, branch: task.workBranch } });
      await tx.insert(auditLog).values({ orgId: task.orgId, actorType: 'agent', actorUserId: task.ownerId, action: 'git.pushed', targetType: 'task', targetId: task.id, metadata: { repo: repo.fullName, branch: task.workBranch, sha: commitSha, files: overlay.length } });
    });

    // A PR is opened if the task wants one, and an already-open PR on the branch is always updated.
    const hasOpenPr = await this.asUser(task.ownerId, (gh) => findOpenPr(gh, repo.owner, repo.name, task.workBranch));
    if (task.createPrOnCompletion || hasOpenPr) {
      const pr = await this.openOrUpdatePr(task.id, { actorUserId: task.ownerId, createdBy: 'agent_on_completion' });
      return { commitSha, prUrl: pr.url };
    }
    await this.notify(task, 'branch.pushed', `${task.key} was pushed to ${task.workBranch}`, 'Open the PR from the task page when you are ready.');
    return { commitSha, prUrl: null };
  }

  /**
   * Opens the PR (base = the repo's default branch), or appends an update to the PR already open on
   * the branch. Used on completion, by the "Create PR" button (as the clicking user), and by the
   * stale-branch job (as the owner).
   */
  async openOrUpdatePr(taskId: string, opts: { actorUserId: string; createdBy: 'user' | 'agent_on_completion' | 'stale_job' }) {
    const { sys } = this.deps;
    const task = await this.task(taskId);
    const [repo] = await sys.select().from(repos).where(eq(repos.id, task.repoId));
    if (!repo) throw new Error('repo not found');
    const ctx = await this.context(task);
    const title = `${task.key}: ${task.title}`;

    const { pr, created } = await this.asUser(opts.actorUserId, async (gh) => {
      await assertCanPush(gh, repo.owner, repo.name);
      const open = await findOpenPr(gh, repo.owner, repo.name, task.workBranch);
      if (open) {
        await updatePrBody(gh, repo.owner, repo.name, open.number, appendToBody(open.body, buildUpdateSection(ctx, new Date())));
        return { pr: open, created: false };
      }
      return { pr: await createPr(gh, { owner: repo.owner, repo: repo.name, head: task.workBranch, base: repo.defaultBranch, title, body: buildPrBody(ctx) }), created: true };
    });

    await sys.transaction(async (tx) => {
      await tx
        .insert(pullRequests)
        .values({ orgId: task.orgId, taskId: task.id, repoId: repo.id, githubPrId: pr.id, number: pr.number, url: pr.url, headBranch: task.workBranch, baseBranch: pr.base, headSha: pr.headSha, createdBy: created ? opts.createdBy : 'user', createdByUserId: opts.actorUserId })
        .onConflictDoUpdate({ target: [pullRequests.repoId, pullRequests.number], set: { taskId: task.id, headSha: pr.headSha, state: 'open' } });
      const [cur] = await tx.select().from(tasks).where(eq(tasks.id, task.id));
      if (cur!.status === 'pushed') await transitionTask(tx, cur!, 'pr_open', { type: opts.createdBy === 'user' ? 'user' : 'agent', userId: opts.createdBy === 'user' ? opts.actorUserId : null }, { pr: pr.number });
      await tx.insert(taskEvents).values({ orgId: task.orgId, taskId: task.id, actorType: opts.createdBy === 'user' ? 'user' : 'agent', actorUserId: opts.actorUserId, type: created ? 'pr.opened' : 'pr.updated', payload: { number: pr.number, url: pr.url } });
      await tx.insert(auditLog).values({ orgId: task.orgId, actorType: opts.createdBy === 'user' ? 'user' : 'agent', actorUserId: opts.actorUserId, action: created ? 'pr.opened' : 'pr.updated', targetType: 'task', targetId: task.id, metadata: { repo: repo.fullName, number: pr.number, createdBy: opts.createdBy } });
    });
    await this.notify(task, created ? 'pr.opened' : 'pr.updated', `${created ? 'PR opened' : 'PR updated'} for ${task.key}`, pr.url);
    if (created && task.sourceTaskId) await this.linkSourcePr(task, repo.fullName, pr);
    return { url: pr.url, number: pr.number, created };
  }

  /**
   * Cross-repo sync (B-3): notes the port's PR on the source task's PR, as the port's owner. Skipped,
   * with a task event saying why, when the owner can't edit the source PR. Never fails the publish.
   */
  private async linkSourcePr(task: Task, repoFullName: string, pr: { number: number; url: string }) {
    const { sys } = this.deps;
    const [source] = await sys.select({ id: tasks.id, key: tasks.key, owner: repos.owner, name: repos.name }).from(tasks).innerJoin(repos, eq(repos.id, tasks.repoId)).where(eq(tasks.id, task.sourceTaskId!));
    const sourcePr = source ? await latestPr(sys, source.id) : null;
    const event = (type: string, payload: Record<string, unknown>) => sys.insert(taskEvents).values({ orgId: task.orgId, taskId: task.id, actorType: 'agent', type, payload });
    if (!source || !sourcePr) return;
    const line = portedToLine({ key: task.key, url: this.taskUrl(await this.orgSlug(task.orgId), task.key), repoFullName, prNumber: pr.number, prUrl: pr.url });
    try {
      await this.deps.vault.withToken(task.ownerId, async (token) => {
        const gh = userOctokit(this.deps.cfg, token);
        const current = await getPr(gh, source.owner, source.name, sourcePr.number);
        await updatePrBody(gh, source.owner, source.name, sourcePr.number, addPortedTo(current.body, line));
      });
      await event('source_pr.updated', { sourceKey: source.key, number: sourcePr.number });
    } catch (e) {
      const s = (e as { status?: number }).status;
      const reason = s === 403 || s === 404 ? 'the owner cannot edit that repository' : e instanceof Error ? e.message : String(e);
      await event('source_pr.not_updated', { sourceKey: source.key, number: sourcePr.number, reason });
    }
  }

  private async context(task: Task): Promise<PrContext> {
    const { sys } = this.deps;
    const slug = await this.orgSlug(task.orgId);
    const [owner] = await sys.select({ login: users.githubLogin }).from(users).where(eq(users.id, task.ownerId));
    const docs = await sys
      .select({ kind: taskDocuments.kind, version: taskDocuments.version, contentMd: taskDocuments.contentMd, reviewerLogin: users.githubLogin })
      .from(taskDocuments)
      .leftJoin(users, eq(users.id, taskDocuments.reviewerId))
      .where(and(eq(taskDocuments.taskId, task.id), eq(taskDocuments.status, 'approved')))
      .orderBy(desc(taskDocuments.version));
    const [ws] = await sys.select().from(workspaces).where(eq(workspaces.taskId, task.id));
    const overlay = ws ? await new PgOverlayStore(sys, ws.id, task.orgId).list() : [];
    const notes = new Map(task.changeNotes.map((n) => [n.path, n.note]));
    const [job] = await sys
      .select({ status: builderJobs.status, docker: builderJobs.docker, config: builderJobs.configSnapshot, durationMs: builderJobs.durationMs, builderName: builders.name })
      .from(builderJobs)
      .leftJoin(builders, eq(builders.id, builderJobs.builderId))
      .where(and(eq(builderJobs.taskId, task.id), eq(builderJobs.final, true), inArray(builderJobs.status, ['passed', 'skipped'])))
      .orderBy(desc(builderJobs.queuedAt))
      .limit(1);
    const config = job?.config as AutodevConfig | null | undefined;
    const [usage] = await sys
      .select({
        models: sql<string[]>`coalesce(array_agg(distinct ${tokenUsage.model}), '{}')`,
        input: sql<string>`coalesce(sum(${tokenUsage.inputTokens}), 0)`,
        output: sql<string>`coalesce(sum(${tokenUsage.outputTokens}), 0)`,
        cached: sql<string>`coalesce(sum(${tokenUsage.cacheReadTokens}), 0)`,
        cost: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)`,
      })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.orgId, task.orgId), eq(tokenUsage.taskId, task.id)));
    const [source] = task.sourceTaskId
      ? await sys.select({ id: tasks.id, key: tasks.key, title: tasks.title, repoFullName: repos.fullName }).from(tasks).innerJoin(repos, eq(repos.id, tasks.repoId)).where(eq(tasks.id, task.sourceTaskId))
      : [];
    const sourcePr = source ? await latestPr(sys, source.id) : null;
    return {
      source: source ? { key: source.key, title: source.title, url: this.taskUrl(slug, source.key), repoFullName: source.repoFullName, pr: sourcePr && { number: sourcePr.number, url: sourcePr.url } } : null,
      task: { key: task.key, title: task.title, url: this.taskUrl(slug, task.key), summaryMd: task.summaryMd, acceptanceCriteriaMd: task.acceptanceCriteriaMd, mode: task.mode },
      ownerLogin: owner?.login ?? 'unknown',
      plan: docs.find((d) => d.kind === 'plan') ?? null,
      lld: docs.find((d) => d.kind === 'lld') ?? null,
      changes: overlay.sort((a, b) => a.path.localeCompare(b.path)).map((o) => ({ path: o.path, op: o.op, note: notes.get(o.path) ?? null })),
      testing:
        job?.status === 'passed' && config
          ? { status: 'passed', builderName: job.builderName, docker: job.docker, image: job.docker ? (config.docker_image ?? DEFAULT_DOCKER_IMAGE) : null, config, durationMs: job.durationMs }
          : { status: 'skipped' },
      usage: { models: usage?.models ?? [], inputTokens: Number(usage?.input ?? 0), outputTokens: Number(usage?.output ?? 0), cacheReadTokens: Number(usage?.cached ?? 0), costUsd: Number(usage?.cost ?? 0) },
    };
  }

  private async asUser<T>(userId: string, fn: (gh: ReturnType<typeof userOctokit>) => Promise<T>): Promise<T> {
    try {
      return await this.deps.vault.withToken(userId, (token) => fn(userOctokit(this.deps.cfg, token)));
    } catch (e) {
      if (e instanceof PushNotAllowed) throw new PublishError('not_allowed', `${e.message}. Nothing was pushed.`);
      if (e instanceof PushConflict) throw new PublishError('conflict', e.message);
      if (e instanceof GitHubReauthRequired) throw new PublishError('reauth', 'The GitHub session expired. Sign in to AutoDev again, then retry the push.');
      const s = (e as { status?: number }).status;
      if (s === 403 || s === 422) throw new PublishError('not_allowed', `GitHub refused the push (${s}): ${(e as Error).message}. Branch protection or rules may block it.`);
      throw e;
    }
  }

  private async task(id: string) {
    const [t] = await this.deps.sys.select().from(tasks).where(eq(tasks.id, id));
    if (!t) throw new Error('task not found');
    return t;
  }

  private async orgSlug(orgId: string) {
    const [o] = await this.deps.sys.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, orgId));
    return o!.slug;
  }

  private taskUrl(slug: string, key: string) {
    return `${this.deps.webUrl}/o/${slug}/tasks/${key}`;
  }

  private async notify(task: Task, type: string, title: string, body: string) {
    await this.deps.sys.insert(notifications).values({ orgId: task.orgId, userId: task.ownerId, type, title, body, link: `/tasks/${task.key}` });
  }
}

export function commitMessage(task: Pick<Task, 'key' | 'title' | 'summaryMd'>, url: string) {
  const subject = `${task.key}: ${task.title}`.slice(0, 72);
  return `${subject}\n\n${(task.summaryMd ?? '').trim()}\n\nAutoDev-Task: ${url}`.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
