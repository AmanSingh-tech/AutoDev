import { codeIndexJob, codeIndexRepoJobId, type CodeIndexJob, type JobQueue } from '@autodev/config';
import type { CodeIndexer } from '@autodev/code-index';

export interface CodeIndexProcessorDeps {
  indexer: Pick<CodeIndexer, 'syncRepo' | 'reposOf' | 'enabledOrgs' | 'purgeOrg'>;
  /** The code-index queue itself: `org` and `nightly` jobs fan out into `repo` jobs. */
  queue: JobQueue<CodeIndexJob>;
}

/**
 * Runs code index jobs. Repo jobs use one job id per repo, so a repo is never indexed twice at
 * once and pushes that arrive while a run waits share it (the queue removes finished jobs, so the
 * id frees up when the run ends).
 */
export function createCodeIndexProcessor(deps: CodeIndexProcessorDeps) {
  const queueOrg = async (orgId: string) => {
    const repoIds = await deps.indexer.reposOf(orgId);
    for (const repoId of repoIds) await deps.queue.add('repo', { kind: 'repo', orgId, repoId }, { jobId: codeIndexRepoJobId(repoId) });
    return repoIds.length;
  };
  return async (job: { data: unknown }) => {
    const data = codeIndexJob.parse(job.data);
    switch (data.kind) {
      case 'repo':
        return deps.indexer.syncRepo(data.orgId, data.repoId);
      case 'org':
        return { queued: await queueOrg(data.orgId) };
      case 'nightly': {
        let queued = 0;
        for (const orgId of await deps.indexer.enabledOrgs()) queued += await queueOrg(orgId);
        return { queued };
      }
      case 'purge':
        return deps.indexer.purgeOrg(data.orgId);
    }
  };
}
