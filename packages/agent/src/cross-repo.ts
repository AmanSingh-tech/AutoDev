import { and, desc, eq, schema, type SystemDb } from '@autodev/db';
import { compareDiff, userOctokit, type GitHubConfig, type KvCache, type TokenVault } from '@autodev/github';
import { PgOverlayStore } from './overlay';
import { GitHubRepoReader } from './repo-reader';
import { VirtualWorkspace } from './workspace';

/**
 * Cross-repo sync (B-3): what a ported task carries from its source. The source change is read
 * once, when the port is created, and frozen into `tasks.source_context_md`, so later work on the
 * source doesn't shift what the port was asked to do.
 */

const { pullRequests, repos, workspaces, workspaceFiles } = schema;

/** `tasks.source_context_md` is capped at this (a DB check). */
export const MAX_SOURCE_CONTEXT_CHARS = 60_000;

export interface SourceChange {
  diff: string;
  /** `pushed`: the commits on the task's branch, from GitHub. `workspace`: the agent's changes, not pushed yet. */
  from: 'pushed' | 'workspace';
}

export interface SourceDeps {
  sys: SystemDb;
  vault: TokenVault;
  cfg: GitHubConfig;
  cache: KvCache;
}

/**
 * The source task's change, read with `userId`'s GitHub access. Pushed work comes from GitHub (so
 * commits people added on the branch count); otherwise the agent's workspace. Null: no changes.
 */
export async function readSourceChange(
  deps: SourceDeps,
  userId: string,
  task: { id: string; orgId: string; repoId: string; baseSha: string | null; lastPushedSha: string | null },
): Promise<SourceChange | null> {
  const [repo] = await deps.sys.select().from(repos).where(eq(repos.id, task.repoId));
  if (!repo) return null;
  const withClient = <T>(fn: (gh: ReturnType<typeof userOctokit>) => Promise<T>) => deps.vault.withToken(userId, (tok) => fn(userOctokit(deps.cfg, tok)));

  if (task.lastPushedSha && task.baseSha && task.lastPushedSha !== task.baseSha) {
    const diff = await withClient((gh) => compareDiff(gh, repo.owner, repo.name, task.baseSha!, task.lastPushedSha!));
    if (diff.trim()) return { diff, from: 'pushed' };
  }
  const [ws] = await deps.sys.select().from(workspaces).where(eq(workspaces.taskId, task.id));
  if (!ws) return null;
  const [any] = await deps.sys.select({ path: workspaceFiles.path }).from(workspaceFiles).where(eq(workspaceFiles.workspaceId, ws.id)).limit(1);
  if (!any) return null;
  const reader = new GitHubRepoReader({ repoId: repo.id, owner: repo.owner, name: repo.name, baseSha: ws.baseSha, cache: deps.cache, withClient });
  const diff = await new VirtualWorkspace(reader, new PgOverlayStore(deps.sys, ws.id, task.orgId), { scope: '' }).patch();
  return diff.trim() ? { diff, from: 'workspace' } : null;
}

/** The source task's latest PR, if it has one. */
export async function latestPr(sys: SystemDb, taskId: string) {
  const [pr] = await sys
    .select({ number: pullRequests.number, url: pullRequests.url, state: pullRequests.state })
    .from(pullRequests)
    .where(and(eq(pullRequests.taskId, taskId)))
    .orderBy(desc(pullRequests.createdAt))
    .limit(1);
  return pr ?? null;
}

export interface SourceContextInput {
  source: { key: string; title: string; url: string; repoFullName: string; descriptionMd: string; summaryMd: string | null };
  pr: { number: number; url: string; state: string } | null;
  mappingNotesMd: string;
  change: SourceChange;
}

/**
 * The frozen context, as Markdown: what the source task did, how the repos map, and the diff. The
 * diff is cut to fit the cap; the rest is short.
 */
export function buildSourceContext(input: SourceContextInput): string {
  const { source, pr, change } = input;
  const head = [
    `Source: [${source.key}: ${source.title}](${source.url}) in \`${source.repoFullName}\`${pr ? `, PR [#${pr.number}](${pr.url}) (${pr.state})` : ''}.`,
    source.summaryMd?.trim() && `### What the source change did\n${source.summaryMd.trim()}`,
    !source.summaryMd?.trim() && source.descriptionMd.trim() && `### The source task\n${source.descriptionMd.trim().slice(0, 4000)}`,
    `### How the repositories map\n${input.mappingNotesMd.trim() || '_No mapping notes. Find the matching code yourself._'}`,
    `### The source diff (${change.from === 'pushed' ? 'the pushed commits' : 'the agent’s changes, not pushed yet'})`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const fence = '````';
  const room = MAX_SOURCE_CONTEXT_CHARS - head.length - 400;
  const diff = change.diff.length <= room ? change.diff : `${change.diff.slice(0, room)}\n[… diff truncated: ${change.diff.length - room} more characters. See the source PR or task.]`;
  return `${head}\n\n${fence}diff\n${diff}\n${fence}`.slice(0, MAX_SOURCE_CONTEXT_CHARS);
}

/** The line added to the source PR when a port's PR opens. */
export function portedToLine(port: { key: string; url: string; repoFullName: string; prNumber: number; prUrl: string }) {
  return `- Ported to \`${port.repoFullName}\` in [#${port.prNumber}](${port.prUrl}) ([${port.key}](${port.url}))`;
}

/** Adds the line under a "Ported to" heading (created once), so several ports stay together. */
export function addPortedTo(body: string, line: string): string {
  if (body.includes(line)) return body;
  const heading = '## Ported to other repositories';
  if (body.includes(heading)) return body.replace(heading, `${heading}\n${line}`);
  return `${body.trimEnd()}\n\n${heading}\n${line}`;
}
