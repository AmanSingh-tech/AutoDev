import { eq, schema, type TaskStatus } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeGitHub } from '../../../../packages/agent/test/fake-github';
import { addMember, API, callerFor, createTestDeps, msw, testCfg } from '../../test/harness';
import { buildServer } from '../server';

const h = createTestDeps();
const { deps } = h;
const app = await buildServer(deps, { logger: false });
beforeAll(() => msw.listen({ onUnhandledRequest: 'error' }));
afterEach(() => msw.resetHandlers());
afterAll(async () => {
  msw.close();
  await app.close();
  await h.close();
});

const BASE = 'a'.repeat(40);
let fx: Awaited<ReturnType<typeof makeOrg>>;
let dev: { id: string };
let other: { id: string };
let gh: ReturnType<typeof fakeGitHub>;
beforeEach(async () => {
  await truncateAll(deps.sys);
  fx = await makeOrg(deps.sys, 'acme');
  dev = await addMember(deps, fx.org.id, 'dev', 'developer');
  other = await addMember(deps, fx.org.id, 'other', 'developer');
  for (const u of [dev, other]) await deps.vault.store(u.id, { accessToken: `ghu_${u.id}`, refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null });
  gh = fakeGitHub(API, 'acme', 'web', { sha: BASE, files: { 'src/app.ts': 'hi\n' } });
  msw.use(...gh.handlers);
});
const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);

async function task(status: TaskStatus, over: Partial<typeof schema.tasks.$inferInsert> = {}) {
  const [t] = await deps.sys
    .insert(schema.tasks)
    .values({ orgId: fx.org.id, repoId: fx.repo.id, number: 1, key: 'AD-1', title: 'Greet', mode: 'direct', branchMode: 'new', workBranch: 'autodev/AD-1-greet', ownerId: dev.id, status, createPrOnCompletion: false, summaryMd: 'hello', ...over })
    .returning();
  const [ws] = await deps.sys.insert(schema.workspaces).values({ orgId: fx.org.id, taskId: t!.id, repoId: fx.repo.id, baseSha: BASE, baseRef: 'main' }).returning();
  await deps.sys.insert(schema.workspaceFiles).values({ workspaceId: ws!.id, orgId: fx.org.id, path: 'src/app.ts', op: 'modify', content: 'hello\n' });
  return t!;
}
const status = async (id: string) => (await deps.sys.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!.status;

describe('Create PR and retry push', () => {
  it('opens the PR as the clicking owner', async () => {
    const t = await task('pushed');
    gh.state.refs.set('autodev/AD-1-greet', BASE);
    expect(await code(as(other).agent.createPr({ key: t.key }))).toBe('FORBIDDEN');
    const pr = await as(dev).agent.createPr({ key: t.key });
    expect(pr).toMatchObject({ number: 1, created: true });
    expect(gh.state.pulls[0]!.author).toBe(`ghu_${dev.id}`);
    expect(await status(t.id)).toBe('pr_open');
    const detail = await as(dev).tasks.get({ key: t.key });
    expect(detail.pullRequests).toMatchObject([{ number: 1, state: 'open', createdBy: 'user' }]);
    expect(detail.can.createPr).toBe(false);
  });

  it('retries only a failed push, and the retry can succeed', async () => {
    gh.state.permission = 'pull';
    const t = await task('testing');
    expect(await deps.publisher.publishOrFail(t.id)).toBe('push_failed:not_allowed');
    const failed = await as(dev).tasks.get({ key: t.key });
    expect(failed).toMatchObject({ status: 'failed', failure: { reason: 'push_failed', kind: 'not_allowed' }, can: { retryPush: true } });

    gh.state.permission = 'push';
    expect(await as(dev).agent.retryPush({ key: t.key })).toEqual({ result: 'published:branch' });
    expect(await status(t.id)).toBe('pushed');
    expect(await code(as(dev).agent.retryPush({ key: t.key }))).toBe('BAD_REQUEST');
  });

  it("won't target the default branch for existing-branch tasks", async () => {
    msw.use(
      http.get(`${API}/user/installations/:id/repositories`, () =>
        HttpResponse.json({ total_count: 1, repositories: [{ id: fx.repo.githubRepoId, name: 'web', full_name: 'acme/web', owner: { login: 'acme' }, default_branch: 'main', private: true, archived: false, permissions: { push: true } }] }),
      ),
    );
    const err = await as(dev).tasks.create({ repoId: fx.repo.id, title: 'x', branchMode: 'existing', targetBranch: 'main' }).catch((e) => e);
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toMatch(/doesn't push to main directly/);
  });
});

describe('pull_request webhooks', () => {
  function send(action: string, pr: object) {
    const body = JSON.stringify({ action, installation: { id: fx.installation.githubInstallationId }, repository: { id: fx.repo.githubRepoId }, sender: { id: 1 }, pull_request: pr });
    return app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': 'sha256=' + createHmac('sha256', testCfg.webhookSecret).update(body).digest('hex') },
      payload: body,
    });
  }
  const pr = (over: object = {}) => ({ id: 9001, number: 3, html_url: 'https://github.com/acme/web/pull/3', merged: false, head: { ref: 'autodev/AD-1-greet', sha: 'h1' }, base: { ref: 'main' }, ...over });

  it('links a PR opened by hand on a pushed task branch, and a merge resolves the task', async () => {
    const t = await task('pushed');
    expect((await send('opened', pr())).json()).toEqual({ result: 'pr:linked' });
    expect(await status(t.id)).toBe('pr_open');

    expect((await send('closed', pr({ merged: true }))).json()).toEqual({ result: 'pr:merged' });
    expect(await status(t.id)).toBe('resolved');
    const [row] = await deps.sys.select().from(schema.pullRequests);
    expect(row).toMatchObject({ state: 'merged', createdBy: 'user' });
    expect(row!.mergedAt).not.toBeNull();
    expect(await deps.sys.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'pr.merged'))).toHaveLength(1);
  });

  it('tracks close and reopen without ending the task, and ignores unrelated PRs', async () => {
    const t = await task('pushed');
    await send('opened', pr());
    expect((await send('closed', pr())).json()).toEqual({ result: 'pr:closed' });
    expect(await status(t.id)).toBe('pr_open');
    expect((await deps.sys.select().from(schema.pullRequests))[0]!.state).toBe('closed');
    expect((await send('reopened', pr())).json()).toEqual({ result: 'pr:reopened' });
    expect((await deps.sys.select().from(schema.pullRequests))[0]!.state).toBe('open');

    expect((await send('opened', pr({ id: 9002, number: 4, head: { ref: 'someone/else', sha: 'x' } }))).json()).toEqual({ result: 'ignored:not_a_task_branch' });
  });
});
