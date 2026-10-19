import { createSystemDb, eq, schema, type TaskMode } from '@autodev/db';
import { makeOrg, testKms, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { MemoryCache, TokenVault, type GitHubConfig } from '@autodev/github';
import { setupServer } from 'msw/node';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeGitHub } from '../test/fake-github';
import { PostgresBlobStore } from '@autodev/storage';
import { AgentOrchestrator } from './orchestrator';
import { Publisher, PublishError } from './publisher';

const API = 'http://github.test/api';
const cfg: GitHubConfig = { appId: 1, appSlug: 'x', privateKey: 'x', clientId: 'x', clientSecret: 'x', webhookSecret: 'x'.repeat(16), apiUrl: API, webUrl: 'http://github.test' };
const sys = createSystemDb(TEST_SYSTEM_URL);
const server = setupServer();
const vault = new TokenVault(sys.db, testKms, cfg);
const cache = new MemoryCache();
const publisher = new Publisher({ sys: sys.db, vault, cfg, cache, webUrl: 'http://web.test' });
const BASE = 'a'.repeat(40);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await sys.close();
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let gh: ReturnType<typeof fakeGitHub>;
let reviewer: { id: string };
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  const [r] = await sys.db.insert(schema.users).values({ githubUserId: 77, githubLogin: 'rita' }).returning();
  reviewer = r!;
  await sys.db.insert(schema.orgMembers).values({ orgId: fx.org.id, userId: reviewer.id, role: 'developer' });
  await vault.store(fx.owner.id, { accessToken: 'ghu_owner', refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null });
  await vault.store(reviewer.id, { accessToken: 'ghu_rita', refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null });
  gh = fakeGitHub(API, 'acme', 'web', { sha: BASE, files: { 'README.md': '# Web\n', 'src/app.ts': 'hi\n', 'bin/run': '#!/bin/sh\n' }, modes: { 'bin/run': '100755' } });
  server.use(...gh.handlers);
});

async function testedTask(over: { mode?: TaskMode; createPr?: boolean; branchMode?: 'new' | 'existing'; workBranch?: string } = {}) {
  const [t] = await sys.db
    .insert(schema.tasks)
    .values({
      orgId: fx.org.id,
      repoId: fx.repo.id,
      number: 1,
      key: 'AD-1',
      title: 'Greet with hello',
      acceptanceCriteriaMd: '- says hello',
      mode: over.mode ?? 'plan_lld',
      branchMode: over.branchMode ?? 'new',
      targetBranch: over.branchMode === 'existing' ? over.workBranch! : null,
      workBranch: over.workBranch ?? 'autodev/AD-1-greet-with-hello',
      ownerId: fx.owner.id,
      status: 'testing',
      createPrOnCompletion: over.createPr ?? true,
      summaryMd: 'greet() now says hello.',
      changeNotes: [{ path: 'src/app.ts', note: 'say hello' }],
    })
    .returning();
  const [ws] = await sys.db.insert(schema.workspaces).values({ orgId: fx.org.id, taskId: t!.id, repoId: fx.repo.id, baseSha: BASE, baseRef: 'main' }).returning();
  await sys.db.insert(schema.workspaceFiles).values([
    { workspaceId: ws!.id, orgId: fx.org.id, path: 'src/app.ts', op: 'modify', content: 'hello\n' },
    { workspaceId: ws!.id, orgId: fx.org.id, path: 'bin/run', op: 'modify', content: '#!/bin/sh\necho hi\n' },
    { workspaceId: ws!.id, orgId: fx.org.id, path: 'src/new.ts', op: 'create', content: 'export {};\n' },
    { workspaceId: ws!.id, orgId: fx.org.id, path: 'README.md', op: 'delete', content: null },
  ]);
  if ((over.mode ?? 'plan_lld') !== 'direct') {
    await sys.db.insert(schema.taskDocuments).values([
      { orgId: fx.org.id, taskId: t!.id, kind: 'plan', version: 2, contentMd: '## Approach\nSay hello.', status: 'approved', reviewerId: reviewer.id },
      { orgId: fx.org.id, taskId: t!.id, kind: 'lld', version: 1, contentMd: '## Files and functions\n- `src/app.ts`', status: 'approved', reviewerId: fx.owner.id },
    ]);
  }
  const [b] = await sys.db.insert(schema.builders).values({ orgId: fx.org.id, ownerUserId: fx.owner.id, name: 'Devi laptop', tokenHash: String(Math.random()) }).returning();
  await sys.db.insert(schema.builderJobs).values({ orgId: fx.org.id, taskId: t!.id, repoId: fx.repo.id, requestedBy: fx.owner.id, builderId: b!.id, baseSha: BASE, workspaceRevision: 4, patchHash: 'k'.repeat(64), patchSha256: 'c'.repeat(64), configSnapshot: { setup: ['pnpm i'], test: ['pnpm test'], timeout_min: 15 }, final: true, status: 'passed', durationMs: 42_000, docker: true });
  await sys.db.insert(schema.tokenUsage).values({ id: uuidv7(), orgId: fx.org.id, taskId: t!.id, userId: fx.owner.id, provider: 'anthropic', model: 'claude-opus-5-5', useCase: 'agent', inputTokens: 123_000, outputTokens: 4_500, cacheReadTokens: 50_000, costUsd: '0.842000' });
  return t!;
}
const task = async (id: string) => (await sys.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!;

describe('Publisher', () => {
  it("pushes as the owner to autodev/<KEY>-<slug> and opens a PR with every section", async () => {
    const t = await testedTask();
    const res = await publisher.publish(t.id);

    // The branch has exactly the change, with the executable bit kept and the deletion applied.
    expect(gh.branchFiles('autodev/AD-1-greet-with-hello')).toEqual({ 'src/app.ts': 'hello\n', 'bin/run': '#!/bin/sh\necho hi\n', 'src/new.ts': 'export {};\n' });
    const commit = gh.state.commits.get(res.commitSha)!;
    expect(commit).toMatchObject({ author: 'ghu_owner', parents: [BASE] });
    expect(commit.message).toBe('AD-1: Greet with hello\n\ngreet() now says hello.\n\nAutoDev-Task: http://web.test/o/acme/tasks/AD-1\n');
    expect(gh.state.trees.get(commit.tree)!['bin/run']!.mode).toBe('100755');

    const pr = gh.state.pulls[0]!;
    expect(pr).toMatchObject({ head: 'autodev/AD-1-greet-with-hello', base: 'main', title: 'AD-1: Greet with hello', author: 'ghu_owner' });
    for (const h of ['## Summary', '## Task', '## Approved Plan', '## Approved LLD', '## Changes', '## Testing', '## AI usage']) expect(pr.body).toContain(h);
    expect(pr.body).toContain('[AD-1: Greet with hello](http://web.test/o/acme/tasks/AD-1)');
    expect(pr.body).toContain('Plan v2, approved by @rita');
    expect(pr.body).toContain('- `src/app.ts` (modified): say hello');
    expect(pr.body).toContain('- `README.md` (deleted)');
    expect(pr.body).toContain('✅ Passed on **Devi laptop** (Docker, `node:22-bookworm`) in 42s.');
    expect(pr.body).toContain('$ pnpm test');
    expect(pr.body).toContain('claude-opus-5-5 · 123k input / 4,500 output tokens (+50.0k cached) · $0.84 · plan approved by @rita, LLD approved by @acme-owner');

    const cur = await task(t.id);
    expect(cur).toMatchObject({ status: 'pr_open', lastPushedSha: res.commitSha });
    const [row] = await sys.db.select().from(schema.pullRequests);
    expect(row).toMatchObject({ number: 1, createdBy: 'agent_on_completion', state: 'open', url: 'https://github.com/acme/web/pull/1' });
    const audit = (await sys.db.select().from(schema.auditLog)).map((a) => a.action).sort();
    expect(audit).toEqual(['git.pushed', 'pr.opened']);
    const events = (await sys.db.select().from(schema.taskEvents)).map((e) => e.type).sort();
    expect(events).toEqual(['branch.pushed', 'pr.opened', 'status_changed', 'status_changed']);
  });

  it('only pushes when the PR toggle is off; "Create PR" later opens it as the clicking user', async () => {
    const t = await testedTask({ createPr: false });
    expect((await publisher.publish(t.id)).prUrl).toBeNull();
    expect((await task(t.id)).status).toBe('pushed');
    expect(gh.state.pulls).toEqual([]);

    await publisher.openOrUpdatePr(t.id, { actorUserId: reviewer.id, createdBy: 'user' });
    expect(gh.state.pulls[0]).toMatchObject({ author: 'ghu_rita' });
    expect((await task(t.id)).status).toBe('pr_open');
    expect((await sys.db.select().from(schema.pullRequests))[0]).toMatchObject({ createdBy: 'user', createdByUserId: reviewer.id });
  });

  it('adds to the open PR of an existing branch and appends an update section', async () => {
    gh.state.refs.set('feature/sso', BASE);
    gh.state.pulls.push({ id: 4000, number: 7, head: 'feature/sso', base: 'main', title: 'SSO', body: 'Original description.', state: 'open', author: 'ghu_owner' });
    const t = await testedTask({ branchMode: 'existing', workBranch: 'feature/sso', createPr: false });
    const res = await publisher.publish(t.id);
    expect(res.prUrl).toBe('https://github.com/acme/web/pull/7');
    expect(gh.state.pulls).toHaveLength(1);
    const body = gh.state.pulls[0]!.body;
    expect(body.startsWith('Original description.')).toBe(true);
    expect(body).toMatch(/---\n\n## AutoDev update · \[AD-1\]\(http:\/\/web\.test\/o\/acme\/tasks\/AD-1\) · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(body).toContain('### Testing');
    expect((await task(t.id)).status).toBe('pr_open');
    expect((await sys.db.select().from(schema.pullRequests))[0]).toMatchObject({ number: 7, createdBy: 'user' });
  });

  it('checks permission live: lost push access pushes nothing and fails the task with a reason', async () => {
    gh.state.permission = 'pull';
    const t = await testedTask();
    await expect(publisher.publish(t.id)).rejects.toBeInstanceOf(PublishError);
    expect(gh.state.refs.has('autodev/AD-1-greet-with-hello')).toBe(false);

    const orchestrator = new AgentOrchestrator({ sys: sys.db, gateway: {} as never, vault, cfg, cache, blobs: new PostgresBlobStore(sys.db), publisher });
    expect(await orchestrator.publish(t)).toBe('push_failed:not_allowed');
    const cur = await task(t.id);
    expect(cur.status).toBe('failed');
    const [ev] = (await sys.db.select().from(schema.taskEvents).where(eq(schema.taskEvents.taskId, t.id))).filter((e) => e.toStatus === 'failed');
    expect(ev!.payload).toMatchObject({ reason: 'push_failed', kind: 'not_allowed' });
  });

  it('refuses to overwrite upstream work on the same files', async () => {
    // Someone else changed src/app.ts on the branch after the agent started.
    const theirs = 'f'.repeat(40);
    gh.state.trees.set('theirtree', { ...gh.state.trees.get('basetree')!, 'src/app.ts': { sha: 'x', mode: '100644' } });
    gh.state.blobs.set('x', 'their change\n');
    gh.state.commits.set(theirs, { tree: 'theirtree', parents: [BASE], message: 'theirs', author: 'other' });
    gh.state.refs.set('feature/sso', theirs);
    const t = await testedTask({ branchMode: 'existing', workBranch: 'feature/sso' });
    const err = await publisher.publish(t.id).catch((e) => e);
    expect(err).toMatchObject({ reason: 'conflict' });
    expect(err.message).toContain('src/app.ts');
    expect(gh.state.refs.get('feature/sso')).toBe(theirs);
  });
});
