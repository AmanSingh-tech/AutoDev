import { eq, schema, type TaskStatus } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeGitHub } from '../../../../packages/agent/test/fake-github';
import { addMember, API, callerFor, createTestDeps, msw } from '../../test/harness';

const h = createTestDeps();
const { deps } = h;
beforeAll(() => msw.listen({ onUnhandledRequest: 'error' }));
afterEach(() => msw.resetHandlers());
afterAll(async () => {
  msw.close();
  await h.close();
});

const BASE = 'a'.repeat(40);
const MOBILE_BASE = 'b'.repeat(40);
let fx: Awaited<ReturnType<typeof makeOrg>>;
let mobile: typeof schema.repos.$inferSelect;
let admin: { id: string };
let dev: { id: string };
/** Can push to web only. */
let webDev: { id: string };
let web: ReturnType<typeof fakeGitHub>;
let mob: ReturnType<typeof fakeGitHub>;

beforeEach(async () => {
  await truncateAll(deps.sys);
  fx = await makeOrg(deps.sys, 'acme');
  [mobile] = await deps.sys
    .insert(schema.repos)
    .values({ orgId: fx.org.id, installationId: fx.installation.id, githubRepoId: fx.repo.githubRepoId + 500_000, owner: 'acme', name: 'mobile', fullName: 'acme/mobile', defaultBranch: 'main', private: true })
    .returning() as [typeof schema.repos.$inferSelect];
  admin = await addMember(deps, fx.org.id, 'admin', 'admin');
  dev = await addMember(deps, fx.org.id, 'dev', 'developer');
  webDev = await addMember(deps, fx.org.id, 'webdev', 'developer');
  for (const u of [admin, dev, webDev]) await deps.vault.store(u.id, { accessToken: `ghu_${u.id}`, refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null });
  web = fakeGitHub(API, 'acme', 'web', { sha: BASE, files: { 'src/app.ts': 'hi\n' } });
  mob = fakeGitHub(API, 'acme', 'mobile', { sha: MOBILE_BASE, files: { 'lib/app.dart': "String greet() => 'hi';\n" } });
  const repoJson = (r: { githubRepoId: number; name: string }) => ({ id: r.githubRepoId, name: r.name, full_name: `acme/${r.name}`, owner: { login: 'acme' }, default_branch: 'main', private: true, archived: false, permissions: { push: true } });
  msw.use(
    ...web.handlers,
    ...mob.handlers,
    // The repos each person can push to: webdev only web, everyone else both.
    http.get(`${API}/user/installations/:id/repositories`, ({ request }) => {
      const list = request.headers.get('authorization')?.includes(webDev.id) ? [repoJson(fx.repo)] : [repoJson(fx.repo), repoJson(mobile)];
      return HttpResponse.json({ total_count: list.length, repositories: list });
    }),
  );
  // As after signing in: each person's repo access is cached.
  for (const u of [admin, dev, webDev]) await deps.repoAccess.listWritable(fx.org.id, u.id);
});
const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);

async function sourceTask(status: TaskStatus, content = 'hello\n') {
  // AD-1 is inserted by hand, so move the org's key counter past it.
  await deps.sys.update(schema.orgs).set({ taskSeq: 1 }).where(eq(schema.orgs.id, fx.org.id));
  const [t] = await deps.sys
    .insert(schema.tasks)
    .values({ orgId: fx.org.id, repoId: fx.repo.id, number: 1, key: 'AD-1', title: 'Greet', descriptionMd: 'Say hello instead of hi.', acceptanceCriteriaMd: '- says hello', mode: 'direct', branchMode: 'new', workBranch: 'autodev/AD-1-greet', baseSha: BASE, ownerId: dev.id, status, summaryMd: 'greet() now says hello.' })
    .returning();
  const [ws] = await deps.sys.insert(schema.workspaces).values({ orgId: fx.org.id, taskId: t!.id, repoId: fx.repo.id, baseSha: BASE, baseRef: 'main' }).returning();
  await deps.sys.insert(schema.workspaceFiles).values({ workspaceId: ws!.id, orgId: fx.org.id, path: 'src/app.ts', op: 'modify', content });
  return t!;
}
const link = (over: { twoWay?: boolean; from?: string; to?: string } = {}) =>
  as(admin).repoLinks.create({ sourceRepoId: over.from ?? fx.repo.id, targetRepoId: over.to ?? mobile.id, twoWay: over.twoWay ?? false, mappingNotesMd: 'src/app.ts ↔ lib/app.dart' });
const taskRow = async (key: string) => (await deps.sys.select().from(schema.tasks).where(eq(schema.tasks.key, key)))[0]!;

describe('repoLinks', () => {
  it('lets admins manage links, audited; members see them; one link per pair', async () => {
    expect(await code(as(dev).repoLinks.create({ sourceRepoId: fx.repo.id, targetRepoId: mobile.id }))).toBe('FORBIDDEN');
    const l = await link();
    expect((await as(dev).repoLinks.list()).links).toMatchObject([{ source: { fullName: 'acme/web' }, target: { fullName: 'acme/mobile' }, twoWay: false }]);
    expect((await as(dev).repoLinks.list()).canEdit).toBe(false);
    expect(await code(link({ from: mobile.id, to: fx.repo.id }))).toBe('CONFLICT');
    expect(await code(link({ to: fx.repo.id }))).toBe('BAD_REQUEST');

    await as(admin).repoLinks.update({ id: l.id, twoWay: true, mappingNotesMd: 'new notes' });
    expect((await as(dev).repoLinks.list()).links[0]).toMatchObject({ twoWay: true, mappingNotesMd: 'new notes' });
    await as(admin).repoLinks.delete({ id: l.id });
    expect((await as(dev).repoLinks.list()).links).toEqual([]);
    const actions = (await deps.sys.select({ a: schema.auditLog.action }).from(schema.auditLog)).map((r) => r.a);
    expect(actions).toEqual(expect.arrayContaining(['repo_link.created', 'repo_link.updated', 'repo_link.deleted']));
  });
});

describe('tasks.applyToLinked', () => {
  it('ports pushed work: a draft in the target with the pushed diff and the mapping notes, linked both ways', async () => {
    await link();
    const src = await sourceTask('testing');
    expect(await code(as(dev).tasks.applyToLinked({ key: src.key, targetRepoId: mobile.id }))).toBe('BAD_REQUEST');
    expect(await deps.publisher.publishOrFail(src.id)).toMatch(/^published/);
    expect((await as(dev).tasks.get({ key: src.key })).linkedTargets).toEqual([{ id: mobile.id, name: 'mobile', fullName: 'acme/mobile' }]);

    const port = await as(dev).tasks.applyToLinked({ key: src.key, targetRepoId: mobile.id });
    expect(port).toMatchObject({ repoId: mobile.id, status: 'draft', title: 'Port AD-1: Greet', acceptanceCriteriaMd: '- says hello', ownerId: dev.id, sourceTaskId: src.id });
    const ctxMd = (await taskRow(port.key)).sourceContextMd!;
    expect(ctxMd).toContain('the pushed commits');
    expect(ctxMd).toContain('-hi');
    expect(ctxMd).toContain('+hello');
    expect(ctxMd).toContain('src/app.ts ↔ lib/app.dart');
    expect(ctxMd).toContain('greet() now says hello.');

    expect((await as(dev).tasks.get({ key: src.key })).ports).toMatchObject([{ key: port.key, repoFullName: 'acme/mobile', status: 'draft' }]);
    expect((await as(dev).tasks.get({ key: port.key })).source).toMatchObject({ key: 'AD-1', repoFullName: 'acme/web' });
    const events = (await deps.sys.select().from(schema.taskEvents).where(eq(schema.taskEvents.taskId, src.id))).map((e) => e.type);
    expect(events).toContain('ported');
  });

  it('uses the agent’s changes when nothing was pushed, and caps a huge diff', async () => {
    await link();
    const src = await sourceTask('pushed', `${'x'.repeat(100)}\n`.repeat(1000));
    const port = await as(dev).tasks.applyToLinked({ key: src.key, targetRepoId: mobile.id });
    const ctxMd = (await taskRow(port.key)).sourceContextMd!;
    expect(ctxMd).toContain('not pushed yet');
    expect(ctxMd).toContain('diff truncated');
    expect(ctxMd.length).toBeLessThanOrEqual(60_000);
  });

  it('follows the link’s direction, and needs push access to the target', async () => {
    const l = await link({ from: mobile.id, to: fx.repo.id });
    const src = await sourceTask('pushed');
    expect((await as(dev).tasks.get({ key: src.key })).linkedTargets).toEqual([]);
    expect(await code(as(dev).tasks.applyToLinked({ key: src.key, targetRepoId: mobile.id }))).toBe('BAD_REQUEST');
    await as(admin).repoLinks.update({ id: l.id, twoWay: true });
    expect(await code(as(webDev).tasks.applyToLinked({ key: src.key, targetRepoId: mobile.id }))).toBe('FORBIDDEN');
    // Listed as writable, but GitHub says otherwise now: the live check wins.
    mob.state.permission = 'pull';
    expect(await code(as(dev).tasks.applyToLinked({ key: src.key, targetRepoId: mobile.id }))).toBe('FORBIDDEN');
    mob.state.permission = 'push';
    expect(await code(as(dev).tasks.applyToLinked({ key: src.key, targetRepoId: mobile.id }))).toBe('OK');
  });

  it('is not reachable from another org', async () => {
    await link();
    const src = await sourceTask('pushed');
    const other = await makeOrg(deps.sys, 'globex');
    const outsider = await addMember(deps, other.org.id, 'outsider', 'admin');
    await deps.vault.store(outsider.id, { accessToken: `ghu_${outsider.id}`, refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null });
    // acme's repo isn't one of globex's, so the target check fails before the task is even looked up.
    expect(await code(callerFor(deps, outsider.id, other.org.id).tasks.applyToLinked({ key: src.key, targetRepoId: mobile.id }))).toBe('FORBIDDEN');
    expect(await deps.sys.select().from(schema.tasks).where(eq(schema.tasks.orgId, other.org.id))).toEqual([]);
  });
});

describe('cross-linked PRs', () => {
  async function portWithPr() {
    await link();
    const src = await sourceTask('testing');
    await deps.publisher.publishOrFail(src.id);
    expect(web.state.pulls).toHaveLength(1);
    const port = await as(dev).tasks.applyToLinked({ key: src.key, targetRepoId: mobile.id });
    // The port's agent finished: a change in mobile, tested, ready to publish.
    await deps.sys.update(schema.tasks).set({ status: 'testing', baseSha: MOBILE_BASE, summaryMd: 'Ported.' }).where(eq(schema.tasks.id, port.id));
    const [ws] = await deps.sys.insert(schema.workspaces).values({ orgId: fx.org.id, taskId: port.id, repoId: mobile.id, baseSha: MOBILE_BASE, baseRef: 'main' }).returning();
    await deps.sys.insert(schema.workspaceFiles).values({ workspaceId: ws!.id, orgId: fx.org.id, path: 'lib/app.dart', op: 'modify', content: "String greet() => 'hello';\n" });
    return { src, port };
  }

  it('puts a Source section in the port’s PR and a "Ported to" line on the source PR', async () => {
    const { port } = await portWithPr();
    expect(await deps.publisher.publishOrFail(port.id)).toMatch(/^published/);
    expect(mob.state.pulls[0]!.body).toContain('## Source\nPorts [AD-1: Greet]');
    expect(mob.state.pulls[0]!.body).toContain('https://github.com/acme/web/pull/1');
    expect(web.state.pulls[0]!.body).toContain('## Ported to other repositories');
    expect(web.state.pulls[0]!.body).toContain(`Ported to \`acme/mobile\` in [#1](https://github.com/acme/mobile/pull/1) ([${port.key}]`);
    const events = (await deps.sys.select().from(schema.taskEvents).where(eq(schema.taskEvents.taskId, port.id))).map((e) => e.type);
    expect(events).toContain('source_pr.updated');
  });

  it('skips the source PR, and says so, when the port owner cannot edit it', async () => {
    const { port } = await portWithPr();
    msw.use(http.patch(`${API}/repos/acme/web/pulls/:n`, () => HttpResponse.json({ message: 'Must have admin rights' }, { status: 403 })));
    expect(await deps.publisher.publishOrFail(port.id)).toMatch(/^published/);
    expect(mob.state.pulls).toHaveLength(1);
    expect(web.state.pulls[0]!.body).not.toContain('Ported to');
    const [ev] = await deps.sys.select().from(schema.taskEvents).where(eq(schema.taskEvents.type, 'source_pr.not_updated'));
    expect(ev!.payload).toMatchObject({ sourceKey: 'AD-1', reason: 'the owner cannot edit that repository' });
  });
});
