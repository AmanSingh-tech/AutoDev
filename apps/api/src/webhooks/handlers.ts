import { and, eq, inArray, isNull, schema, transitionTask } from '@autodev/db';
import type { Deps } from '../deps';

const { auditLog, installations, orgMembers, pullRequests, repos, taskEvents, tasks, users } = schema;

type HandlerDeps = Pick<Deps, 'sys' | 'repoAccess' | 'queues'>;

interface Payload {
  action?: string;
  installation?: { id: number; permissions?: Record<string, string>; events?: string[]; account?: { id: number } };
  member?: { id: number };
  pull_request?: { id: number; number: number; html_url: string; merged: boolean; draft?: boolean; head: { ref: string; sha: string }; base: { ref: string } };
  repository?: { id: number };
  sender?: { id: number };
  membership?: { user?: { id: number } };
  [k: string]: unknown;
}

/**
 * Applies GitHub webhook events. Signature checks and delivery dedupe happen in the route.
 * Webhooks only invalidate caches and update metadata: user access is always re-read with the
 * user's own token, so a forged-but-signed payload can't grant anyone access.
 */
export async function handleWebhook(deps: HandlerDeps, event: string, p: Payload): Promise<string> {
  const ghInstallationId = p.installation?.id;
  if (!ghInstallationId) return 'ignored:no_installation';

  if (event === 'installation') return handleInstallation(deps, p);

  const inst = await findInstallation(deps, ghInstallationId);
  if (!inst) return 'ignored:unknown_installation';

  switch (event) {
    case 'installation_repositories':
    case 'repository':
      await enqueueSync(deps, ghInstallationId);
      await deps.repoAccess.invalidateOrg(inst.orgId);
      return 'synced';

    case 'member': {
      // A collaborator was added, removed or had their permission changed on one repo.
      const userId = await userIdForGithubId(deps, p.member?.id);
      if (userId) await deps.repoAccess.invalidateUser(inst.orgId, userId);
      return 'invalidated:user';
    }

    case 'organization': {
      if (p.action === 'member_removed') {
        const userId = await userIdForGithubId(deps, p.membership?.user?.id);
        if (userId) await removeMember(deps, inst.orgId, userId);
      }
      await deps.repoAccess.invalidateOrg(inst.orgId);
      return 'invalidated:org';
    }

    case 'pull_request':
      return handlePullRequest(deps, inst.orgId, p);

    case 'membership':
    case 'team':
    case 'team_add':
      await deps.repoAccess.invalidateOrg(inst.orgId);
      return 'invalidated:org';

    default:
      return 'ignored:event';
  }
}

async function handleInstallation(deps: HandlerDeps, p: Payload): Promise<string> {
  const gh = p.installation!;
  const inst = await findInstallation(deps, gh.id, { includeDeleted: true });
  const now = new Date();

  switch (p.action) {
    case 'deleted': {
      if (!inst) return 'ignored:unknown_installation';
      await deps.sys.transaction(async (tx) => {
        await tx.update(installations).set({ deletedAt: now }).where(eq(installations.id, inst.id));
        await tx.update(repos).set({ deletedAt: now }).where(and(eq(repos.installationId, inst.id), isNull(repos.deletedAt)));
        await tx.insert(auditLog).values({
          orgId: inst.orgId,
          actorType: 'system',
          action: 'installation.deleted',
          targetType: 'installation',
          targetId: String(gh.id),
        });
      });
      await deps.repoAccess.invalidateOrg(inst.orgId);
      return 'installation:deleted';
    }
    case 'suspend':
    case 'unsuspend': {
      if (!inst) return 'ignored:unknown_installation';
      await deps.sys
        .update(installations)
        .set({ suspendedAt: p.action === 'suspend' ? now : null })
        .where(eq(installations.id, inst.id));
      await deps.repoAccess.invalidateOrg(inst.orgId);
      return `installation:${p.action}`;
    }
    case 'new_permissions_accepted': {
      if (!inst) return 'ignored:unknown_installation';
      await deps.sys
        .update(installations)
        .set({ permissions: gh.permissions ?? {}, events: gh.events ?? [] })
        .where(eq(installations.id, inst.id));
      return 'installation:permissions';
    }
    case 'created':
      // The org is linked in the setup callback, where we know who the installer is.
      // If the account is already an org here (a re-install), restore the installation now.
      if (inst?.deletedAt) {
        await deps.sys.update(installations).set({ deletedAt: null, suspendedAt: null }).where(eq(installations.id, inst.id));
        await enqueueSync(deps, gh.id);
        return 'installation:restored';
      }
      return 'ignored:awaiting_setup';
    default:
      return 'ignored:action';
  }
}

/**
 * Keeps task PRs in sync with GitHub. A merge resolves the task. A PR opened by hand on a task's
 * branch (pushed, no PR yet) gets linked to the task.
 */
async function handlePullRequest(deps: HandlerDeps, orgId: string, p: Payload): Promise<string> {
  const pr = p.pull_request;
  if (!pr || !p.repository) return 'ignored:payload';
  const [repo] = await deps.sys.select().from(repos).where(and(eq(repos.orgId, orgId), eq(repos.githubRepoId, p.repository.id)));
  if (!repo) return 'ignored:unknown_repo';
  const system = { type: 'system' as const, userId: null };
  let [row] = await deps.sys.select().from(pullRequests).where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.number, pr.number)));

  if (!row && (p.action === 'opened' || p.action === 'reopened')) {
    const [task] = await deps.sys.select().from(tasks).where(and(eq(tasks.repoId, repo.id), eq(tasks.workBranch, pr.head.ref), inArray(tasks.status, ['pushed'])));
    if (!task) return 'ignored:not_a_task_branch';
    const author = p.sender ? await userIdForGithubId(deps, p.sender.id) : null;
    [row] = await deps.sys
      .insert(pullRequests)
      .values({ orgId, taskId: task.id, repoId: repo.id, githubPrId: pr.id, number: pr.number, url: pr.html_url, headBranch: pr.head.ref, baseBranch: pr.base.ref, headSha: pr.head.sha, draft: !!pr.draft, createdBy: 'user', createdByUserId: author })
      .returning();
    await transitionTask(deps.sys, task, 'pr_open', system, { pr: pr.number, linked: true });
    await deps.sys.insert(taskEvents).values({ orgId, taskId: task.id, actorType: 'system', type: 'pr.opened', payload: { number: pr.number, url: pr.html_url, linked: true } });
    return 'pr:linked';
  }
  if (!row) return 'ignored:untracked_pr';

  if (p.action === 'closed') {
    const merged = pr.merged;
    await deps.sys.update(pullRequests).set({ state: merged ? 'merged' : 'closed', headSha: pr.head.sha, ...(merged ? { mergedAt: new Date() } : { closedAt: new Date() }) }).where(eq(pullRequests.id, row.id));
    if (merged) {
      const [task] = await deps.sys.select().from(tasks).where(eq(tasks.id, row.taskId));
      if (task && (task.status === 'pr_open' || task.status === 'pushed')) await transitionTask(deps.sys, task, 'resolved', system, { pr: pr.number, merged: true });
      await deps.sys.insert(auditLog).values({ orgId, actorType: 'system', action: 'pr.merged', targetType: 'task', targetId: row.taskId, metadata: { repo: repo.fullName, number: pr.number } });
    }
    await deps.sys.insert(taskEvents).values({ orgId, taskId: row.taskId, actorType: 'system', type: merged ? 'pr.merged' : 'pr.closed', payload: { number: pr.number } });
    return merged ? 'pr:merged' : 'pr:closed';
  }
  if (p.action === 'reopened') {
    await deps.sys.update(pullRequests).set({ state: 'open', closedAt: null, headSha: pr.head.sha }).where(eq(pullRequests.id, row.id));
    await deps.sys.insert(taskEvents).values({ orgId, taskId: row.taskId, actorType: 'system', type: 'pr.reopened', payload: { number: pr.number } });
    return 'pr:reopened';
  }
  if (p.action === 'synchronize' || p.action === 'edited' || p.action === 'ready_for_review' || p.action === 'converted_to_draft') {
    await deps.sys.update(pullRequests).set({ headSha: pr.head.sha, draft: !!pr.draft, baseBranch: pr.base.ref }).where(eq(pullRequests.id, row.id));
    return 'pr:updated';
  }
  return 'ignored:action';
}

async function findInstallation(deps: HandlerDeps, ghId: number, opts: { includeDeleted?: boolean } = {}) {
  const [row] = await deps.sys
    .select()
    .from(installations)
    .where(
      opts.includeDeleted
        ? eq(installations.githubInstallationId, ghId)
        : and(eq(installations.githubInstallationId, ghId), isNull(installations.deletedAt)),
    );
  return row ?? null;
}

async function userIdForGithubId(deps: HandlerDeps, githubUserId: number | undefined) {
  if (!githubUserId) return null;
  const [u] = await deps.sys.select({ id: users.id }).from(users).where(eq(users.githubUserId, githubUserId));
  return u?.id ?? null;
}

async function removeMember(deps: HandlerDeps, orgId: string, userId: string) {
  await deps.sys.transaction(async (tx) => {
    const updated = await tx
      .update(orgMembers)
      .set({ status: 'removed' })
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId), eq(orgMembers.status, 'active')))
      .returning();
    if (updated.length) {
      await tx.insert(auditLog).values({
        orgId,
        actorType: 'system',
        action: 'member.removed_on_github',
        targetType: 'user',
        targetId: userId,
      });
    }
  });
}

const enqueueSync = (deps: HandlerDeps, githubInstallationId: number) =>
  deps.queues.repoSync.add(
    'installation',
    { kind: 'installation', githubInstallationId },
    { jobId: `installation-${githubInstallationId}` },
  );
