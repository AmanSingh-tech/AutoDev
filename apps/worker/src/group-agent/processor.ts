import { githubSource } from '@autodev/code-index';
import type { GroupAgentJob } from '@autodev/config';
import type { SystemDb } from '@autodev/db';
import type { GitHubConfig } from '@autodev/github';
import type { RepoFiles } from './scans';
import { enabledOrgs, runDigest, runScan, type GroupAgentDeps } from './run';
import type { SourceUrls } from './sources';

/** Lists a repo's files at its default branch head and reads them by path, with the installation token. */
export function installationFiles(cfg: GitHubConfig) {
  return async (repo: { owner: string; name: string; defaultBranch: string; githubInstallationId: number }): Promise<RepoFiles> => {
    const source = githubSource(cfg, repo);
    const { entries } = await source.tree(await source.head());
    const blobs = new Map(entries.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
    return { paths: [...blobs.keys()], read: async (path) => (await source.readBlob(blobs.get(path)!)).toString('utf8') };
  };
}

/**
 * The `group-agent` queue. With an org id (an admin's "Scan now"), that org runs even if the agent is
 * off; without one (the nightly and weekly schedules), every org that turned it on runs.
 */
export const createGroupAgentProcessor = (deps: { sys: SystemDb; urls: SourceUrls; cfg: GitHubConfig; filesFor?: GroupAgentDeps['filesFor'] }) => {
  const agent: GroupAgentDeps = { sys: deps.sys, urls: deps.urls, filesFor: deps.filesFor ?? installationFiles(deps.cfg) };
  return async (job: { data: GroupAgentJob }) => {
    const orgIds = job.data.orgId ? [job.data.orgId] : await enabledOrgs(deps.sys);
    const results: Record<string, unknown> = {};
    for (const orgId of orgIds) {
      results[orgId] = job.data.kind === 'digest' ? await runDigest(deps.sys, orgId, new Date(), { force: !!job.data.orgId }) : await runScan(agent, orgId, new Date(), { force: !!job.data.orgId });
    }
    return results;
  };
};
