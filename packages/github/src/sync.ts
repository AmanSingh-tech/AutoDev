import { and, eq, isNull, notInArray, schema, type SystemDb } from '@autodev/db';
import type { Octokit } from './clients';

const { installations, repos } = schema;

/**
 * Syncs an installation's repo list using the installation token (a background job).
 * Repos no longer in the installation are soft-deleted. This never grants any user access:
 * user_repo_access only comes from the user's own token.
 */
export async function syncInstallationRepos(
  sys: SystemDb,
  installationClient: Octokit,
  githubInstallationId: number,
): Promise<{ upserted: number; removed: number }> {
  const [inst] = await sys
    .select()
    .from(installations)
    .where(eq(installations.githubInstallationId, githubInstallationId));
  if (!inst || inst.deletedAt) return { upserted: 0, removed: 0 };

  const list = await installationClient.paginate(installationClient.rest.apps.listReposAccessibleToInstallation, {
    per_page: 100,
  });
  const now = new Date();
  return sys.transaction(async (tx) => {
    for (const r of list) {
      const fields = {
        owner: r.owner.login,
        name: r.name,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        private: r.private,
        archived: r.archived,
        lastSyncedAt: now,
      };
      await tx
        .insert(repos)
        .values({ orgId: inst.orgId, installationId: inst.id, githubRepoId: r.id, ...fields })
        .onConflictDoUpdate({
          target: repos.githubRepoId,
          set: { ...fields, installationId: inst.id, deletedAt: null },
          setWhere: eq(repos.orgId, inst.orgId),
        });
    }
    const ids = list.map((r) => r.id);
    const removed = await tx
      .update(repos)
      .set({ deletedAt: now })
      .where(
        and(
          eq(repos.installationId, inst.id),
          isNull(repos.deletedAt),
          ids.length ? notInArray(repos.githubRepoId, ids) : undefined,
        ),
      )
      .returning({ id: repos.id });
    return { upserted: list.length, removed: removed.length };
  });
}
