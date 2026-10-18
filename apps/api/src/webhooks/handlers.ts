import { and, eq, isNull, schema } from '@autodev/db';
import type { Deps } from '../deps';

const { auditLog, installations, orgMembers, repos, users } = schema;

type HandlerDeps = Pick<Deps, 'sys' | 'repoAccess' | 'queues'>;

interface Payload {
  action?: string;
  installation?: { id: number; permissions?: Record<string, string>; events?: string[]; account?: { id: number } };
  member?: { id: number };
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
