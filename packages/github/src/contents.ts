import type { Octokit } from './clients';

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

/** The full recursive tree at a commit. GitHub truncates very large trees (about 100k entries / 7 MB). */
export async function getTree(gh: Octokit, owner: string, repo: string, sha: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const { data } = await gh.rest.git.getTree({ owner, repo, tree_sha: sha, recursive: 'true' });
  return {
    truncated: data.truncated,
    entries: data.tree
      .filter((e) => (e.type === 'blob' || e.type === 'tree') && e.path && e.sha)
      .map((e) => ({ path: e.path!, type: e.type as 'blob' | 'tree', sha: e.sha!, ...(e.size !== undefined ? { size: e.size } : {}) })),
  };
}

/** One directory level at a commit. Used when the recursive tree came back truncated. */
export async function listDirAt(gh: Octokit, owner: string, repo: string, sha: string, path: string): Promise<TreeEntry[]> {
  const { data } = await gh.rest.repos.getContent({ owner, repo, ref: sha, path });
  const items = Array.isArray(data) ? data : [data];
  return items
    .filter((i) => i.type === 'file' || i.type === 'dir')
    .map((i) => ({ path: i.path, type: i.type === 'dir' ? 'tree' : 'blob', sha: i.sha, size: i.size }));
}

/** Raw bytes of a blob. Blobs are content-addressed, so the result can be cached forever by sha. */
export async function getBlob(gh: Octokit, owner: string, repo: string, blobSha: string): Promise<Buffer> {
  const { data } = await gh.rest.git.getBlob({ owner, repo, file_sha: blobSha });
  return Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8');
}

/** The head commit of a branch. */
export async function getBranchHead(gh: Octokit, owner: string, repo: string, branch: string): Promise<string> {
  const { data } = await gh.rest.repos.getBranch({ owner, repo, branch });
  return data.commit.sha;
}

/**
 * GitHub code search. Note: it only indexes the default branch and is heavily rate-limited, so the
 * agent uses it only when a bounded local search isn't possible.
 */
export async function searchCode(gh: Octokit, owner: string, repo: string, query: string, opts: { path?: string } = {}) {
  const q = `${query} repo:${owner}/${repo}${opts.path ? ` path:${opts.path}` : ''}`;
  const { data } = await gh.rest.search.code({ q, per_page: 50 });
  return data.items.map((i) => i.path);
}
