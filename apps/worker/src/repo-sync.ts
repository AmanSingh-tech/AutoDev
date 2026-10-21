import { repoSyncJob } from '@autodev/config';
import { eq, schema, type SystemDb } from '@autodev/db';
import { installationOctokit, syncInstallationRepos, type GitHubConfig, type Octokit } from '@autodev/github';

export interface RepoSyncDeps {
  sys: SystemDb;
  cfg: GitHubConfig;
  /** Called after an installation's repos are synced (the code index picks up new repos). */
  onSynced?: (orgId: string) => Promise<unknown>;
  /** Overridable in tests. */
  clientFor?: (githubInstallationId: number) => Octokit;
}

export function createRepoSyncProcessor(deps: RepoSyncDeps) {
  const clientFor = deps.clientFor ?? ((id: number) => installationOctokit(deps.cfg, id));
  return async (job: { data: unknown }) => {
    const data = repoSyncJob.parse(job.data);
    switch (data.kind) {
      case 'installation': {
        const result = await syncInstallationRepos(deps.sys, clientFor(data.githubInstallationId), data.githubInstallationId);
        if (deps.onSynced) {
          const [inst] = await deps.sys
            .select({ orgId: schema.installations.orgId })
            .from(schema.installations)
            .where(eq(schema.installations.githubInstallationId, data.githubInstallationId));
          if (inst) await deps.onSynced(inst.orgId);
        }
        return result;
      }
    }
  };
}
