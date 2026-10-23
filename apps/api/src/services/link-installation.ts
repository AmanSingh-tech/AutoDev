import { and, eq, insertOrgWithOwner, schema } from '@autodev/db';
import { getOrgMembership, syncMemberships, userOctokit } from '@autodev/github';
import type { Deps } from '../deps';

const { auditLog, installations, orgMembers, orgs, users } = schema;

export type LinkResult =
  | { ok: true; orgSlug: string; created: boolean }
  | { ok: false; reason: 'installation_not_visible' | 'not_github_admin' | 'installation_owned_elsewhere' | 'unsupported_account' };

/**
 * GitHub's post-install redirect lands here. We never trust the installation_id in the URL:
 * the installation has to show up in the user's own /user/installations list, and creating
 * an org needs GitHub org admin (or ownership of a personal account).
 */
export async function linkInstallation(
  deps: Pick<Deps, 'sys' | 'vault' | 'cfg' | 'kms' | 'queues'> & { env?: Partial<Pick<Deps['env'], 'DATA_REGION'>> },
  userId: string,
  githubInstallationId: number,
): Promise<LinkResult> {
  const [user] = await deps.sys.select().from(users).where(eq(users.id, userId));
  if (!user) return { ok: false, reason: 'installation_not_visible' };

  const found = await deps.vault.withToken(userId, async (token) => {
    const gh = userOctokit(deps.cfg, token);
    const list = await gh.paginate(gh.rest.apps.listInstallationsForAuthenticatedUser, { per_page: 100 });
    const inst = list.find((i) => i.id === githubInstallationId);
    if (!inst?.account || !('login' in inst.account)) return null;
    const account = { id: inst.account.id, login: inst.account.login, type: inst.target_type };
    let isAdmin = false;
    if (account.type === 'User') isAdmin = account.id === user.githubUserId;
    else if (account.type === 'Organization') {
      const m = await getOrgMembership(gh, account.login);
      isAdmin = m?.state === 'active' && m.role === 'admin';
    }
    return { inst, account, isAdmin };
  });
  if (!found) return { ok: false, reason: 'installation_not_visible' };
  const { inst, account, isAdmin } = found;
  if (account.type !== 'User' && account.type !== 'Organization') return { ok: false, reason: 'unsupported_account' };

  const result = await deps.sys.transaction(async (tx): Promise<LinkResult> => {
    let [org] = await tx.select().from(orgs).where(eq(orgs.githubAccountId, account.id));
    let created = false;
    if (!org) {
      if (!isAdmin) return { ok: false, reason: 'not_github_admin' };
      org = await insertOrgWithOwner(tx, deps.kms, {
        githubAccountId: account.id,
        githubLogin: account.login,
        accountType: account.type as 'User' | 'Organization',
        name: account.login,
        ownerUserId: userId,
        dataRegion: deps.env?.DATA_REGION,
      });
      created = true;
    } else if (isAdmin) {
      // An org admin on GitHub who isn't an AutoDev member yet joins as admin,
      // or as owner if the org somehow has no active owner.
      const [existing] = await tx
        .select()
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, userId)));
      if (!existing) {
        const owners = await tx
          .select()
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.role, 'owner'), eq(orgMembers.status, 'active')));
        await tx.insert(orgMembers).values({ orgId: org.id, userId, role: owners.length ? 'admin' : 'owner' });
      }
    }

    const fields = {
      accountLogin: account.login,
      accountType: account.type as 'User' | 'Organization',
      permissions: (inst.permissions ?? {}) as Record<string, string>,
      events: inst.events ?? [],
      deletedAt: null,
      suspendedAt: inst.suspended_at ? new Date(inst.suspended_at) : null,
    };
    const [row] = await tx
      .insert(installations)
      .values({ orgId: org.id, githubInstallationId, installedByUserId: userId, ...fields })
      .onConflictDoUpdate({ target: installations.githubInstallationId, set: fields, setWhere: eq(installations.orgId, org.id) })
      .returning();
    if (!row) return { ok: false, reason: 'installation_owned_elsewhere' };

    await tx.insert(auditLog).values({
      orgId: org.id,
      actorType: 'user',
      actorUserId: userId,
      action: created ? 'org.created' : 'installation.linked',
      targetType: 'installation',
      targetId: String(githubInstallationId),
      metadata: { account: account.login },
    });
    return { ok: true, orgSlug: org.slug, created };
  });

  if (result.ok) {
    await deps.queues.repoSync.add(
      'installation',
      { kind: 'installation', githubInstallationId },
      { jobId: `installation-${githubInstallationId}` },
    );
    // Non-admin members who can see the installation join with the default role.
    await syncMemberships(deps, userId, user.githubUserId);
  }
  return result;
}
