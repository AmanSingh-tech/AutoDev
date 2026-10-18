import type { Octokit } from './clients';

/** Hard stop for the branch dropdown: big monorepos can have tens of thousands of branches. */
export const MAX_BRANCHES = 1000;

export interface BranchInfo {
  name: string;
  sha: string;
  protected: boolean;
}

/** Lists branches with the user's token (so it shows exactly what they can see), up to MAX_BRANCHES. */
export async function listBranches(gh: Octokit, owner: string, repo: string): Promise<{ branches: BranchInfo[]; truncated: boolean }> {
  const branches: BranchInfo[] = [];
  for await (const page of gh.paginate.iterator(gh.rest.repos.listBranches, { owner, repo, per_page: 100 })) {
    for (const b of page.data) branches.push({ name: b.name, sha: b.commit.sha, protected: b.protected });
    if (branches.length >= MAX_BRANCHES) return { branches: branches.slice(0, MAX_BRANCHES), truncated: true };
  }
  return { branches, truncated: false };
}

/** Returns the branch head, or null if the branch doesn't exist (or the user can't see it). */
export async function getBranch(gh: Octokit, owner: string, repo: string, branch: string): Promise<BranchInfo | null> {
  try {
    const { data } = await gh.rest.repos.getBranch({ owner, repo, branch });
    return { name: data.name, sha: data.commit.sha, protected: data.protected };
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

/** Git ref rules we accept for an existing branch name (a subset of git-check-ref-format). */
export function isValidBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.includes('@{') &&
    name !== '@'
  );
}

/** autodev/AD-142-fix-login-redirect: ASCII slug of the title, at most 40 characters. */
export function newBranchName(taskKey: string, title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `autodev/${taskKey}${slug ? `-${slug}` : ''}`;
}
