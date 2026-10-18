import { eq, schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, ANTHROPIC, API, callerFor, createTestDeps, msw } from '../../test/harness';

const h = createTestDeps();
const { deps } = h;
beforeAll(() => msw.listen({ onUnhandledRequest: 'error' }));
afterAll(async () => {
  msw.close();
  await h.close();
});
afterEach(() => msw.resetHandlers());

let fx: Awaited<ReturnType<typeof makeOrg>>;
let admin: { id: string };
let dev: { id: string };
let dev2: { id: string };
let viewer: { id: string };

const token = (u: { id: string }) =>
  deps.vault.store(u.id, { accessToken: `ghu_${u.id}`, refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null });

/** GitHub: every user can push to acme/web except `readOnly`; branches main and feature/login exist. */
function github(readOnly: string[] = []) {
  msw.use(
    http.get(`${API}/user/installations/:id/repositories`, ({ request }) => {
      const uid = request.headers.get('authorization')!.replace('token ghu_', '');
      const push = !readOnly.includes(uid);
      return HttpResponse.json({
        total_count: 1,
        repositories: [
          { id: fx.repo.githubRepoId, name: 'web', full_name: 'acme/web', owner: { login: 'acme' }, default_branch: 'main', private: true, archived: false, permissions: { push, pull: true } },
        ],
      });
    }),
    http.get(`${API}/repos/acme/web/branches/:b`, ({ params }) =>
      ['main', 'feature/login'].includes(params.b as string)
        ? HttpResponse.json({ name: params.b, commit: { sha: 'abc123' }, protected: false })
        : new HttpResponse(null, { status: 404 }),
    ),
    http.get(`${API}/repos/acme/web/branches`, () =>
      HttpResponse.json([{ name: 'main', commit: { sha: 'abc' }, protected: true }, { name: 'feature/login', commit: { sha: 'def' }, protected: false }]),
    ),
    http.get(`${ANTHROPIC}/v1/models`, () => HttpResponse.json({ data: [], has_more: false })),
  );
}

beforeEach(async () => {
  await truncateAll(deps.sys);
  h.agentJobs.length = 0;
  fx = await makeOrg(deps.sys, 'acme');
  admin = await addMember(deps, fx.org.id, 'admin', 'admin');
  dev = await addMember(deps, fx.org.id, 'dev', 'developer');
  dev2 = await addMember(deps, fx.org.id, 'dev2', 'developer');
  viewer = await addMember(deps, fx.org.id, 'viewer', 'viewer');
  for (const u of [admin, dev, dev2, viewer]) await token(u);
  github();
});

const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);
const base = () => ({ repoId: fx.repo.id, title: 'Fix login redirect', branchMode: 'new' as const });
const addOrgKey = () => as(admin).llmKeys.create({ scope: 'org', provider: 'anthropic', label: 'k', apiKey: 'sk-ant-good-0123456789-ABCD' });

describe('tasks.create', () => {
  it('mints sequential keys per org even under concurrency, with the org prefix', async () => {
    const created = await Promise.all(Array.from({ length: 6 }, () => as(dev).tasks.create(base())));
    expect(created.map((t) => t.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(created.every((t) => t.key === `AD-${t.number}`)).toBe(true);

    await as(admin).orgs.updateSettings({ taskKeyPrefix: 'WEB' });
    const next = await as(dev).tasks.create(base());
    expect(next.key).toBe('WEB-7');
  });

  it('defaults to a draft on a new autodev/<KEY>-<slug> branch with the org default mode', async () => {
    const t = await as(dev).tasks.create(base());
    expect(t).toMatchObject({ status: 'draft', mode: 'plan_lld', workBranch: 'autodev/AD-1-fix-login-redirect', targetBranch: null, ownerId: dev.id, createPrOnCompletion: true });
  });

  it('starts from an existing branch only if it exists on GitHub', async () => {
    const t = await as(dev).tasks.create({ ...base(), branchMode: 'existing', targetBranch: 'feature/login' });
    expect(t).toMatchObject({ targetBranch: 'feature/login', workBranch: 'feature/login' });
    const err = await as(dev).tasks.create({ ...base(), branchMode: 'existing', targetBranch: 'nope' }).catch((e) => e);
    expect(err.message).toMatch(/doesn't exist/);
    expect(await code(as(dev).tasks.create({ ...base(), branchMode: 'existing' }))).toBe('BAD_REQUEST');
  });

  it('honors a repo mode lock and the repo default mode', async () => {
    await as(admin).repos.setPolicy({ repoId: fx.repo.id, lockedMode: null, defaultMode: 'plan_only' });
    expect((await as(dev).tasks.create(base())).mode).toBe('plan_only');
    expect((await as(dev).tasks.create({ ...base(), mode: 'direct' })).mode).toBe('direct');

    await as(admin).repos.setPolicy({ repoId: fx.repo.id, lockedMode: 'plan_lld', defaultMode: null });
    expect(await code(as(dev).tasks.create({ ...base(), mode: 'direct' }))).toBe('BAD_REQUEST');
    expect((await as(dev).tasks.create(base())).mode).toBe('plan_lld');
  });

  it('normalizes scope_path and rejects paths outside the repo', async () => {
    expect((await as(dev).tasks.create({ ...base(), scopePath: './packages//web/' })).scopePath).toBe('packages/web');
    for (const bad of ['../x', '/etc', 'a/../../b', 'a\\b']) {
      expect(await code(as(dev).tasks.create({ ...base(), scopePath: bad }))).toBe('BAD_REQUEST');
    }
  });

  it('links a related task in the same org only', async () => {
    const first = await as(dev).tasks.create(base());
    const follow = await as(dev).tasks.create({ ...base(), relatedTaskId: first.id, extraContext: 'Also cover SSO' });
    expect(follow.relatedTaskId).toBe(first.id);
    const detail = await as(dev).tasks.get({ key: follow.key });
    expect(detail.related).toMatchObject({ key: first.key });

    const other = await makeOrg(deps.sys, 'globex');
    const [foreign] = await deps.sys
      .insert(schema.tasks)
      .values({ orgId: other.org.id, repoId: other.repo.id, number: 1, key: 'AD-1', title: 'x', mode: 'direct', branchMode: 'new', workBranch: 'autodev/AD-1', ownerId: other.owner.id })
      .returning();
    expect(await code(as(dev).tasks.create({ ...base(), relatedTaskId: foreign!.id }))).toBe('BAD_REQUEST');
  });

  it('requires push access on GitHub and a non-viewer role', async () => {
    expect(await code(as(viewer).tasks.create(base()))).toBe('FORBIDDEN');
    github([dev2.id]);
    await deps.repoAccess.invalidateOrg(fx.org.id);
    expect(await code(as(dev2).tasks.create(base()))).toBe('FORBIDDEN');
  });
});

describe('task lifecycle', () => {
  it('refuses to start without a working LLM key, then queues a job once one exists', async () => {
    const t = await as(dev).tasks.create(base());
    const err = await as(dev).tasks.start({ key: t.key }).catch((e) => e);
    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(err.message).toMatch(/No working LLM key/);
    expect(h.agentJobs).toEqual([]);

    await addOrgKey();
    const started = await as(dev).tasks.start({ key: t.key });
    expect(started.status).toBe('queued');
    expect(h.agentJobs).toEqual([expect.objectContaining({ name: 'run', data: { kind: 'run', orgId: fx.org.id, taskId: t.id } })]);
  });

  it('refuses to start when the owner hit a hard budget', async () => {
    await addOrgKey();
    await as(admin).budgets.set({ scope: 'user', userId: dev.id, limitUsd: 1 });
    await deps.sys.insert(schema.tokenUsage).values({ id: uuidv7(), orgId: fx.org.id, userId: dev.id, provider: 'anthropic', model: 'claude-opus-5-5', useCase: 'agent', costUsd: '2.00' });
    const t = await as(dev).tasks.create(base());
    const err = await as(dev).tasks.start({ key: t.key }).catch((e) => e);
    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(err.message).toMatch(/budget/);
  });

  it('can create and start in one step', async () => {
    await addOrgKey();
    expect((await as(dev).tasks.create({ ...base(), start: true })).status).toBe('queued');
  });

  it('allows edits only in draft, and only by the owner or an admin', async () => {
    await addOrgKey();
    const t = await as(dev).tasks.create(base());
    expect(await code(as(dev2).tasks.update({ key: t.key, title: 'hijack' }))).toBe('FORBIDDEN');
    const edited = await as(admin).tasks.update({ key: t.key, title: 'Fix SSO login', priority: 'urgent' });
    expect(edited).toMatchObject({ title: 'Fix SSO login', priority: 'urgent', workBranch: 'autodev/AD-1-fix-sso-login' });

    await as(dev).tasks.start({ key: t.key });
    expect(await code(as(dev).tasks.update({ key: t.key, title: 'late' }))).toBe('BAD_REQUEST');
    await as(dev).tasks.unqueue({ key: t.key });
    expect(await code(as(dev).tasks.update({ key: t.key, title: 'ok now' }))).toBe('OK');
  });

  it('cancels, records every change as an event, and blocks invalid transitions', async () => {
    const t = await as(dev).tasks.create(base());
    expect(await code(as(dev).tasks.unqueue({ key: t.key }))).toBe('BAD_REQUEST');
    await as(dev).tasks.cancel({ key: t.key, reason: 'duplicate' });
    expect(await code(as(dev).tasks.cancel({ key: t.key }))).toBe('BAD_REQUEST');

    const detail = await as(dev).tasks.get({ key: t.key });
    expect(detail.status).toBe('cancelled');
    expect(detail.completedAt).not.toBeNull();
    expect(detail.can).toEqual({ edit: false, start: false, unqueue: false, cancel: false });
    expect(detail.events.map((e) => [e.type, e.toStatus])).toEqual([
      ['status_changed', 'cancelled'],
      ['created', null],
    ]);
  });
});

describe('tasks.list and board data', () => {
  it('filters by repo, board column, search and owner, urgent first', async () => {
    await addOrgKey();
    const a = await as(dev).tasks.create({ ...base(), title: 'Low thing', priority: 'low' });
    const b = await as(dev).tasks.create({ ...base(), title: 'Urgent outage', priority: 'urgent' });
    await as(dev2).tasks.create({ ...base(), title: 'Someone else' });
    await as(dev).tasks.start({ key: a.key });

    expect((await as(dev).tasks.list({ repoId: fx.repo.id })).map((t) => t.title)).toEqual(['Urgent outage', 'Someone else', 'Low thing']);
    expect((await as(dev).tasks.list({ column: 'queued' })).map((t) => t.key)).toEqual([a.key]);
    expect((await as(dev).tasks.list({ q: 'outage' })).map((t) => t.key)).toEqual([b.key]);
    expect((await as(dev).tasks.list({ q: b.key })).map((t) => t.key)).toEqual([b.key]);
    expect((await as(dev).tasks.list({ mine: true })).length).toBe(2);
    expect((await as(dev).tasks.list({ q: '%' })).length).toBe(0);
  });

  it('lets viewers see the board but not create on it', async () => {
    await as(dev).tasks.create(base());
    expect(await as(viewer).repos.byName({ name: 'web' })).toMatchObject({ id: fx.repo.id, canCreate: false });
    expect(await as(dev).repos.byName({ name: 'web' })).toMatchObject({ canCreate: true });
    expect(await as(viewer).tasks.list({})).toHaveLength(1);
  });

  it('lists branches with the caller token and caches them', async () => {
    let calls = 0;
    msw.use(
      http.get(`${API}/repos/acme/web/branches`, () => {
        calls++;
        return HttpResponse.json([{ name: 'main', commit: { sha: 'abc' }, protected: true }]);
      }),
    );
    expect((await as(dev).repos.branches({ repoId: fx.repo.id })).branches.map((b) => b.name)).toEqual(['main']);
    await as(dev2).repos.branches({ repoId: fx.repo.id });
    expect(calls).toBe(1);
  });

  it("isolates another org's tasks", async () => {
    const t = await as(dev).tasks.create(base());
    const other = await makeOrg(deps.sys, 'globex');
    expect(await code(callerFor(deps, other.owner.id, other.org.id).tasks.get({ key: t.key }))).toBe('NOT_FOUND');
    const [row] = await deps.sys.select().from(schema.tasks).where(eq(schema.tasks.id, t.id));
    expect(row!.orgId).toBe(fx.org.id);
  });
});
