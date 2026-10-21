import type { Octokit } from './clients';

export interface CommitChange {
  path: string;
  op: 'create' | 'modify' | 'delete';
  content: string | null;
  /** Mode at the base commit; new files are 100644. */
  mode?: string;
}

/** The branch moved upstream and touched files this change also touches. Nothing was pushed. */
export class PushConflict extends Error {
  override name = 'PushConflict';
  constructor(readonly paths: string[]) {
    super(`The branch changed upstream in ${paths.join(', ')} since the agent started. Nothing was pushed.`);
  }
}

const status = (e: unknown) => (e as { status?: number }).status;

/**
 * Commits a change set to a branch with the Git Data API (no clone), as whoever owns `gh`'s token.
 * - New branch: created from baseSha.
 * - Branch at baseSha: fast-forwarded.
 * - Branch moved since baseSha: the commit goes on top of the new head, unless upstream touched the
 *   same files (then PushConflict). Never force-pushes.
 */
export async function commitToBranch(
  gh: Octokit,
  input: { owner: string; repo: string; branch: string; baseSha: string; changes: CommitChange[]; message: string },
): Promise<{ commitSha: string; createdBranch: boolean; parentSha: string }> {
  const { owner, repo, branch, baseSha } = input;
  let head: string | null = null;
  try {
    head = (await gh.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })).data.object.sha;
  } catch (e) {
    if (status(e) !== 404) throw e;
  }

  if (head && head !== baseSha) {
    const cmp = (await gh.rest.repos.compareCommits({ owner, repo, base: baseSha, head })).data;
    if (cmp.status !== 'ahead') throw new PushConflict(input.changes.map((c) => c.path));
    const upstream = new Set((cmp.files ?? []).flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]));
    const clash = input.changes.map((c) => c.path).filter((p) => upstream.has(p));
    if (clash.length) throw new PushConflict(clash);
  }
  const parentSha = head ?? baseSha;
  const parent = (await gh.rest.git.getCommit({ owner, repo, commit_sha: parentSha })).data;

  const entries = [];
  for (const c of input.changes) {
    if (c.op === 'delete') {
      entries.push({ path: c.path, mode: (c.mode ?? '100644') as '100644', type: 'blob' as const, sha: null });
    } else {
      const blob = (await gh.rest.git.createBlob({ owner, repo, content: c.content ?? '', encoding: 'utf-8' })).data;
      entries.push({ path: c.path, mode: (c.mode ?? '100644') as '100644', type: 'blob' as const, sha: blob.sha });
    }
  }
  const tree = (await gh.rest.git.createTree({ owner, repo, base_tree: parent.tree.sha, tree: entries })).data;
  const commit = (await gh.rest.git.createCommit({ owner, repo, message: input.message, tree: tree.sha, parents: [parentSha] })).data;

  if (head) {
    try {
      await gh.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha, force: false });
    } catch (e) {
      // Someone pushed in the last few hundred milliseconds.
      if (status(e) === 422) throw new PushConflict(input.changes.map((c) => c.path));
      throw e;
    }
  } else {
    await gh.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit.sha });
  }
  return { commitSha: commit.sha, createdBranch: !head, parentSha };
}

export interface PrInfo {
  id: number;
  number: number;
  url: string;
  headSha: string;
  body: string;
  base: string;
}

const toInfo = (p: { id: number; number: number; html_url: string; head: { sha: string }; body?: string | null; base: { ref: string } }): PrInfo => ({
  id: p.id,
  number: p.number,
  url: p.html_url,
  headSha: p.head.sha,
  body: p.body ?? '',
  base: p.base.ref,
});

export async function findOpenPr(gh: Octokit, owner: string, repo: string, branch: string): Promise<PrInfo | null> {
  const { data } = await gh.rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: 'open', per_page: 1 });
  return data[0] ? toInfo(data[0]) : null;
}

export async function createPr(gh: Octokit, input: { owner: string; repo: string; head: string; base: string; title: string; body: string }): Promise<PrInfo> {
  const { data } = await gh.rest.pulls.create({ ...input, maintainer_can_modify: true });
  return toInfo(data);
}

export async function updatePrBody(gh: Octokit, owner: string, repo: string, number: number, body: string) {
  await gh.rest.pulls.update({ owner, repo, pull_number: number, body });
}

export async function getPr(gh: Octokit, owner: string, repo: string, number: number): Promise<PrInfo> {
  const { data } = await gh.rest.pulls.get({ owner, repo, pull_number: number });
  return toInfo(data);
}
