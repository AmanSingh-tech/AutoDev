import { repoSyncJob } from '@autodev/config';
import type { SystemDb } from '@autodev/db';
import { installationOctokit, syncInstallationRepos, type GitHubConfig, type Octokit } from '@autodev/github';

export interface RepoSyncDeps {
  sys: SystemDb;
  cfg: GitHubConfig;
  /** Overridable in tests. */
  clientFor?: (githubInstallationId: number) => Octokit;
}

export function createRepoSyncProcessor(deps: RepoSyncDeps) {
  const clientFor = deps.clientFor ?? ((id: number) => installationOctokit(deps.cfg, id));
  return async (job: { data: unknown }) => {
    const data = repoSyncJob.parse(job.data);
    switch (data.kind) {
      case 'installation':
        return syncInstallationRepos(deps.sys, clientFor(data.githubInstallationId), data.githubInstallationId);
    }
  };
}
