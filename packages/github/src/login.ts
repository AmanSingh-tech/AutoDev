import { and, eq, inArray, isNull, schema, type SystemDb } from '@autodev/db';
import { userOctokit } from './clients';
import type { GitHubConfig } from './config';
import type { TokenSet } from './oauth';
import type { TokenVault } from './vault';

const { auditLog, installations, orgMembers, orgs, users } = schema;

export interface GitHubProfile {
  id: number;
  login: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}

export interface LoginDeps {
  sys: SystemDb;
  vault: TokenVault;
  cfg: GitHubConfig;
}

/**
 * Runs after a successful GitHub sign-in: upserts the user, stores their tokens encrypted,
 * writes the audit entry and auto-joins orgs they belong to on GitHub.
 */
export async function completeLogin(
  deps: LoginDeps,
  input: { profile: GitHubProfile; tokens: TokenSet; ip?: string | null; userAgent?: string | null },
): Promise<{ userId: string }> {
  const { profile } = input;
  const profileFields = {
    githubLogin: profile.login,
    name: profile.name ?? null,
    email: profile.email ?? null,
    avatarUrl: profile.avatar_url ?? null,
    lastLoginAt: new Date(),
  };
  const [user] = await deps.sys
    .insert(users)
    .values({ githubUserId: profile.id, ...profileFields })
    .onConflictDoUpdate({ target: users.githubUserId, set: profileFields })
    .returning({ id: users.id });
  const userId = user!.id;

  await deps.vault.store(userId, input.tokens);
  await deps.sys.insert(auditLog).values({
    actorType: 'user',
    actorUserId: userId,
    action: 'auth.login',
    targetType: 'user',
    targetId: userId,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });
  await syncMemberships(deps, userId, profile.id);
  return { userId };
}

/**
 * Auto-joins the user to every AutoDev org whose installation they can see and where they're an
 * active GitHub org member, with that org's default role. Removed members aren't re-added;
 * an admin has to restore them.
 */
export async function syncMemberships(deps: LoginDeps, userId: string, githubUserId: number) {
  await deps.vault.withToken(userId, async (token) => {
    const gh = userOctokit(deps.cfg, token);
    const visible = await gh.paginate(gh.rest.apps.listInstallationsForAuthenticatedUser, { per_page: 100 });
    if (!visible.length) return;

    const known = await deps.sys
      .select({ org: orgs })
      .from(installations)
      .innerJoin(orgs, eq(orgs.id, installations.orgId))
      .where(
        and(
          inArray(installations.githubInstallationId, visible.map((i) => i.id)),
          isNull(installations.deletedAt),
        ),
      );
    const existing = await deps.sys
      .select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .where(eq(orgMembers.userId, userId));
    const already = new Set(existing.map((m) => m.orgId));

    for (const { org } of known) {
      if (already.has(org.id)) continue;
      const isMember =
        org.accountType === 'User'
          ? org.githubAccountId === githubUserId
          : await isActiveOrgMember(gh, org.githubLogin);
      if (!isMember) continue;
      await deps.sys
        .insert(orgMembers)
        .values({ orgId: org.id, userId, role: org.defaultMemberRole })
        .onConflictDoNothing();
      already.add(org.id);
      await deps.sys.insert(auditLog).values({
        orgId: org.id,
        actorType: 'system',
        actorUserId: userId,
        action: 'member.auto_joined',
        targetType: 'user',
        targetId: userId,
        metadata: { role: org.defaultMemberRole },
      });
    }
  });
}

export async function isActiveOrgMember(
  gh: ReturnType<typeof userOctokit>,
  org: string,
): Promise<boolean> {
  return (await getOrgMembership(gh, org))?.state === 'active';
}

export async function getOrgMembership(gh: ReturnType<typeof userOctokit>, org: string) {
  try {
    const { data } = await gh.rest.orgs.getMembershipForAuthenticatedUser({ org });
    return { state: data.state, role: data.role };
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 403 || status === 404) return null;
    throw e;
  }
}
