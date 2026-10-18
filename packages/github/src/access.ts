import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  schema,
  sql,
  WRITE_PERMISSIONS,
  withOrg,
  type AppDb,
  type RepoPermission,
  type SystemDb,
} from '@autodev/db';
import { userOctokit } from './clients';
import type { KvCache } from './cache';
import type { GitHubConfig } from './config';
import { highestPermission } from './permissions';
import type { TokenVault } from './vault';

const { installations, repos, userRepoAccess } = schema;

export const REPO_ACCESS_TTL_SECONDS = 15 * 60;

export interface WritableRepo {
  id: string;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  permission: RepoPermission;
}

interface FetchedRepo {
  githubRepoId: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  permission: RepoPermission | null;
}

/**
 * Which repos a user can push to in an org. Data comes from GitHub with the user's own token
 * and is cached for 15 minutes. Webhooks invalidate the cache, either for one user or for a
 * whole org (by bumping the org's cache version).
 */
export class RepoAccessService {
  constructor(
    private readonly deps: {
      app: AppDb;
      sys: SystemDb;
      vault: TokenVault;
      cache: KvCache;
      cfg: GitHubConfig;
    },
  ) {}

  async listWritable(orgId: string, userId: string, opts: { force?: boolean } = {}) {
    if (opts.force || !(await this.isFresh(orgId, userId))) await this.refresh(orgId, userId);
    return withOrg(this.deps.app, orgId, userId, (tx) =>
      tx
        .select({
          id: repos.id,
          fullName: repos.fullName,
          owner: repos.owner,
          name: repos.name,
          defaultBranch: repos.defaultBranch,
          private: repos.private,
          permission: userRepoAccess.permission,
        })
        .from(userRepoAccess)
        .innerJoin(repos, eq(repos.id, userRepoAccess.repoId))
        .where(
          and(
            eq(userRepoAccess.userId, userId),
            inArray(userRepoAccess.permission, [...WRITE_PERMISSIONS]),
            isNull(repos.deletedAt),
            eq(repos.archived, false),
          ),
        )
        .orderBy(asc(repos.fullName)),
    ) as Promise<WritableRepo[]>;
  }

  /** Re-reads the user's access from GitHub and replaces their cached rows for this org. */
  async refresh(orgId: string, userId: string): Promise<void> {
    const { sys, vault, cache, cfg } = this.deps;
    const insts = await sys
      .select()
      .from(installations)
      .where(
        and(eq(installations.orgId, orgId), isNull(installations.deletedAt), isNull(installations.suspendedAt)),
      );

    const fetched = await vault.withToken(userId, async (token) => {
      const gh = userOctokit(cfg, token);
      const out: { installationId: string; repos: FetchedRepo[] }[] = [];
      for (const inst of insts) {
        try {
          const list = await gh.paginate(gh.rest.apps.listInstallationReposForAuthenticatedUser, {
            installation_id: inst.githubInstallationId,
            per_page: 100,
          });
          out.push({
            installationId: inst.id,
            repos: list.map((r) => ({
              githubRepoId: r.id,
              owner: r.owner.login,
              name: r.name,
              fullName: r.full_name,
              defaultBranch: r.default_branch,
              private: r.private,
              archived: r.archived,
              permission: highestPermission(r.permissions),
            })),
          });
        } catch (e) {
          // 403/404: the user can't see this installation (e.g. not a member any more).
          const status = (e as { status?: number }).status;
          if (status === 403 || status === 404) out.push({ installationId: inst.id, repos: [] });
          else throw e;
        }
      }
      return out;
    });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + REPO_ACCESS_TTL_SECONDS * 1000);
    // System role: the refresh may discover repos that aren't in the table yet. Every write is scoped to orgId.
    await sys.transaction(async (tx) => {
      const access: (typeof userRepoAccess.$inferInsert)[] = [];
      for (const { installationId, repos: list } of fetched) {
        for (const r of list) {
          const [row] = await tx
            .insert(repos)
            .values({ orgId, installationId, ...withoutPermission(r), lastSyncedAt: now })
            .onConflictDoUpdate({
              target: repos.githubRepoId,
              set: { ...withoutPermission(r), installationId, deletedAt: null, lastSyncedAt: now },
              // Never take over a repo row that belongs to another org.
              setWhere: eq(repos.orgId, orgId),
            })
            .returning({ id: repos.id });
          if (row && r.permission) {
            access.push({ userId, repoId: row.id, orgId, permission: r.permission, fetchedAt: now, expiresAt });
          }
        }
      }
      await tx
        .delete(userRepoAccess)
        .where(and(eq(userRepoAccess.orgId, orgId), eq(userRepoAccess.userId, userId)));
      if (access.length) await tx.insert(userRepoAccess).values(access);
    });

    await cache.set(await this.freshKey(orgId, userId), now.toISOString(), REPO_ACCESS_TTL_SECONDS);
  }

  async invalidateUser(orgId: string, userId: string) {
    await this.deps.cache.del(await this.freshKey(orgId, userId));
    await this.deps.sys
      .update(userRepoAccess)
      .set({ expiresAt: sql`now()` })
      .where(and(eq(userRepoAccess.orgId, orgId), eq(userRepoAccess.userId, userId)));
  }

  /** O(1) invalidation for the whole org: bumping the version orphans every user's freshness key. */
  async invalidateOrg(orgId: string) {
    await this.deps.cache.incr(`repo-access:ver:${orgId}`);
    await this.deps.sys
      .update(userRepoAccess)
      .set({ expiresAt: sql`now()` })
      .where(eq(userRepoAccess.orgId, orgId));
  }

  private async isFresh(orgId: string, userId: string) {
    return (await this.deps.cache.get(await this.freshKey(orgId, userId))) !== null;
  }

  private async freshKey(orgId: string, userId: string) {
    const ver = (await this.deps.cache.get(`repo-access:ver:${orgId}`)) ?? '0';
    return `repo-access:fresh:${orgId}:${ver}:${userId}`;
  }
}

function withoutPermission({ permission: _, ...rest }: FetchedRepo) {
  return rest;
}
