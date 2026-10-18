import { WRITE_PERMISSIONS, type RepoPermission } from '@autodev/db';
import type { Octokit } from './clients';
import { PushNotAllowed } from './errors';

export interface GitHubPermissions {
  admin?: boolean;
  maintain?: boolean;
  push?: boolean;
  triage?: boolean;
  pull?: boolean;
}

const ORDER: RepoPermission[] = ['admin', 'maintain', 'push', 'triage', 'pull'];

export function highestPermission(p: GitHubPermissions | undefined): RepoPermission | null {
  if (!p) return null;
  return ORDER.find((level) => p[level]) ?? null;
}

export const canPush = (perm: RepoPermission | null): boolean =>
  perm !== null && WRITE_PERMISSIONS.includes(perm);

/**
 * Live check with the user's own token, run right before every push or PR.
 * The cached user_repo_access is never trusted for this.
 */
export async function assertCanPush(
  userClient: Octokit,
  owner: string,
  repo: string,
): Promise<RepoPermission> {
  const fullName = `${owner}/${repo}`;
  try {
    const { data } = await userClient.rest.repos.get({ owner, repo });
    const perm = highestPermission(data.permissions);
    if (data.archived || !canPush(perm)) throw new PushNotAllowed(fullName);
    return perm!;
  } catch (e) {
    if (e instanceof PushNotAllowed) throw e;
    if ((e as { status?: number }).status === 404) throw new PushNotAllowed(fullName);
    throw e;
  }
}
