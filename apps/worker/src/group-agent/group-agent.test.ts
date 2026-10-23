import { randomUUID } from 'node:crypto';
import { and, createSystemDb, eq, isNull, schema } from '@autodev/db';
import { makeOrg, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { healthByRepo, runDigest, runScan, type GroupAgentDeps } from './run';

const sys = createSystemDb(TEST_SYSTEM_URL);
const server = setupServer();
const urls = { OSV_API_URL: 'http://osv.test', NPM_REGISTRY_URL: 'http://npm.test', PYPI_URL: 'http://pypi.test', GOPROXY_URL: 'http://go.test' };
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await sys.close();
});

/** Repo name → its files. Each test sets what the repos contain. */
let files: Record<string, Record<string, string>> = {};
const deps: GroupAgentDeps = {
  sys: sys.db,
  urls,
  filesFor: async (repo) => {
    const f = files[repo.name] ?? {};
    return { paths: Object.keys(f), read: async (p) => f[p]! };
  },
};
const npmLock = (lodash: string) =>
  JSON.stringify({ packages: { '': { dependencies: { lodash: '^4', vitest: '^2' } }, 'node_modules/lodash': { version: lodash }, 'node_modules/vitest': { version: '2.1.0' } } });

/** OSV knows one advisory, for lodash below 4.17.21; the registry's latest lodash is 4.17.21, vitest 2.1.5. */
function registries(opts: { osvDown?: boolean } = {}) {
  server.use(
    http.post('http://osv.test/v1/querybatch', async ({ request }) => {
      if (opts.osvDown) return new HttpResponse(null, { status: 503 });
      const body = (await request.json()) as { queries: { package: { name: string }; version: string }[] };
      return HttpResponse.json({ results: body.queries.map((q) => (q.package.name === 'lodash' && q.version === '4.17.20' ? { vulns: [{ id: 'GHSA-35jh-r3h4-6jhm' }] } : {})) });
    }),
    http.get('http://osv.test/v1/vulns/:id', () =>
      HttpResponse.json({
        id: 'GHSA-35jh-r3h4-6jhm',
        aliases: ['CVE-2021-23337'],
        summary: 'Command injection in lodash',
        database_specific: { severity: 'HIGH' },
        affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
      }),
    ),
    http.get('http://npm.test/:name/latest', ({ params }) => HttpResponse.json({ version: params.name === 'lodash' ? '4.17.21' : '2.1.5' })),
  );
}

let fx: Awaited<ReturnType<typeof makeOrg>>;
let api: { id: string };
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  const [r] = await sys.db
    .insert(schema.repos)
    .values({ orgId: fx.org.id, installationId: fx.installation.id, githubRepoId: 77_001, owner: 'acme', name: 'api', fullName: 'acme/api', defaultBranch: 'main', private: true })
    .returning();
  api = r!;
  files = { web: { 'package-lock.json': npmLock('4.17.20') }, api: { 'package-lock.json': npmLock('4.17.20') } };
});

const open = () => sys.db.select().from(schema.groupAgentFindings).where(and(eq(schema.groupAgentFindings.orgId, fx.org.id), isNull(schema.groupAgentFindings.resolvedAt)));
const recFor = async (fingerprintPart: string) => {
  const rows = await sys.db.select({ f: schema.groupAgentFindings, r: schema.recommendations }).from(schema.recommendations).innerJoin(schema.groupAgentFindings, eq(schema.groupAgentFindings.id, schema.recommendations.findingId));
  return rows.find((x) => x.f.fingerprint.includes(fingerprintPart))!;
};

describe('dependency scan', () => {
  it('reports the vulnerable package per repo, the repeat across repos, and outdated direct dependencies', async () => {
    registries();
    const r = await runScan(deps, fx.org.id, new Date(), { force: true });
    expect(r).toMatchObject({ errors: [], resolved: 0 });

    const findings = await open();
    const kinds = findings.map((f) => `${f.kind}:${f.repoId ?? 'org'}`).sort();
    expect(kinds).toEqual(
      [`outdated_dependency:${api.id}`, `outdated_dependency:${api.id}`, `outdated_dependency:${fx.repo.id}`, `outdated_dependency:${fx.repo.id}`, 'repeated_failure:org', `vulnerable_dependency:${api.id}`, `vulnerable_dependency:${fx.repo.id}`].sort(),
    );
    const vuln = await recFor(`vuln:${fx.repo.id}`);
    expect(vuln.f).toMatchObject({ severity: 'high', title: 'lodash 4.17.20 has CVE-2021-23337' });
    expect(vuln.r).toMatchObject({ status: 'open', fixKind: 'dependency_bump', title: 'Upgrade lodash to 4.17.21 in acme/web' });
    expect(vuln.r.bodyMd).toContain('Fixed in **4.17.21** (a patch upgrade)');
    expect((await recFor('repeated:vuln')).f.details).toMatchObject({ repoIds: expect.arrayContaining([fx.repo.id, api.id]) });
    expect(await healthByRepo(sys.db, fx.org.id)).toEqual({ [fx.repo.id]: 100 - 15 - 15 - 2 - 2, [api.id]: 100 - 15 - 15 - 2 - 2 });
  });

  it('resolves what is fixed on the next scan, keeps dismissals, and reopens what comes back', async () => {
    registries();
    await runScan(deps, fx.org.id, new Date(), { force: true });
    const outdated = await recFor(`outdated:${api.id}:npm:vitest`);
    await sys.db.update(schema.recommendations).set({ status: 'dismissed', dismissedReason: 'pinned on purpose' }).where(eq(schema.recommendations.id, outdated.r.id));

    files.web = { 'package-lock.json': npmLock('4.17.21') };
    const second = await runScan(deps, fx.org.id, new Date(), { force: true });
    expect(second.resolved).toBe(3); // web's advisory and its lodash bump, and the repeat across repos
    expect((await recFor(`vuln:${fx.repo.id}`)).r.status).toBe('resolved');
    expect((await recFor(`vuln:${api.id}`)).r.status).toBe('open');
    expect((await recFor(`outdated:${api.id}:npm:vitest`)).r.status).toBe('dismissed');

    files.web = { 'package-lock.json': npmLock('4.17.20') };
    const third = await runScan(deps, fx.org.id, new Date(), { force: true });
    expect(third.reopened).toBe(3);
    expect((await recFor(`vuln:${fx.repo.id}`)).r.status).toBe('open');
  });

  it('leaves findings alone when OSV is down, and records the error', async () => {
    registries();
    await runScan(deps, fx.org.id, new Date(), { force: true });
    server.resetHandlers();
    registries({ osvDown: true });
    const r = await runScan(deps, fx.org.id, new Date(), { force: true });
    expect(r.resolved).toBe(0);
    expect(r.errors).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'dependencies', message: 'osv.test answered 503' })]));
    expect((await open()).filter((f) => f.kind === 'vulnerable_dependency')).toHaveLength(2);
  });

  it('does nothing for an org that has not turned the agent on', async () => {
    expect(await runScan(deps, fx.org.id)).toEqual({ skipped: 'disabled' });
  });
});

describe('internal checks', () => {
  beforeEach(() => {
    files = {};
  });
  const now = new Date();
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
  let n = 0;
  async function task(o: Partial<typeof schema.tasks.$inferInsert> & { repoId?: string }) {
    n++;
    const [t] = await sys.db
      .insert(schema.tasks)
      .values({ orgId: fx.org.id, repoId: fx.repo.id, number: n, key: `AD-${n}`, title: `Task ${n}`, mode: 'direct', branchMode: 'new', workBranch: `autodev/AD-${n}`, ownerId: fx.owner.id, ...o })
      .returning();
    return t!;
  }

  it('finds stuck tasks, merged work not ported to a linked repo, and unusual spend', async () => {
    const waiting = await task({ status: 'awaiting_plan_approval' });
    await sys.db.insert(schema.taskEvents).values({ orgId: fx.org.id, taskId: waiting.id, actorType: 'agent', type: 'status_changed', toStatus: 'awaiting_plan_approval', createdAt: daysAgo(3) });
    const fresh = await task({ status: 'awaiting_plan_approval' });
    await sys.db.insert(schema.taskEvents).values({ orgId: fx.org.id, taskId: fresh.id, actorType: 'agent', type: 'status_changed', toStatus: 'awaiting_plan_approval', createdAt: daysAgo(1) });

    await sys.db.insert(schema.repoLinks).values({ orgId: fx.org.id, sourceRepoId: fx.repo.id, targetRepoId: api.id });
    const merged = await task({ status: 'resolved' });
    await sys.db.insert(schema.pullRequests).values({ orgId: fx.org.id, taskId: merged.id, repoId: fx.repo.id, githubPrId: 5_001, number: 1, url: 'u', headBranch: 'b', baseBranch: 'main', state: 'merged', createdBy: 'user', mergedAt: daysAgo(2) });

    const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 12 * 3_600_000);
    for (const [when, cost] of [
      [yesterday, '40'],
      [daysAgo(3), '2'],
      [daysAgo(4), '3'],
    ] as const)
      await sys.db.insert(schema.tokenUsage).values({ id: randomUUID(), orgId: fx.org.id, userId: fx.owner.id, repoId: fx.repo.id, provider: 'anthropic', model: 'm', useCase: 'agent', costUsd: cost, createdAt: when });

    await runScan(deps, fx.org.id, now, { force: true });
    const f = await open();
    expect(f.filter((x) => x.kind === 'stuck_task').map((x) => x.title)).toEqual([`${waiting.key} is waiting for a person for 3 days`]);
    expect(f.filter((x) => x.kind === 'linked_repo_drift')).toEqual([expect.objectContaining({ repoId: api.id, title: `${merged.key} merged in acme/web, not ported to acme/api` })]);
    expect(f.filter((x) => x.kind === 'unusual_spend').map((x) => x.details.who).sort()).toEqual(['repo', 'user']);

    // Porting it resolves the drift on the next scan.
    await task({ repoId: api.id, sourceTaskId: merged.id, status: 'draft' });
    await runScan(deps, fx.org.id, now, { force: true });
    expect((await open()).filter((x) => x.kind === 'linked_repo_drift')).toHaveLength(0);
  });

  it('finds failing and flaky tests, and the same failure in two repos', async () => {
    const t = await task({ status: 'testing' });
    const t2 = await task({ status: 'testing', repoId: api.id });
    const job = (o: { repoId?: string; taskId?: string; status: 'passed' | 'failed'; patch: string; tests?: { name: string; message?: string }[]; at: number }) => ({
      orgId: fx.org.id,
      taskId: o.taskId ?? t.id,
      repoId: o.repoId ?? fx.repo.id,
      requestedBy: fx.owner.id,
      baseSha: 'a'.repeat(40),
      patchHash: o.patch,
      patchSha256: o.patch,
      workspaceRevision: 1,
      status: o.status,
      failedTests: o.tests ?? [],
      finishedAt: daysAgo(o.at),
    });
    const err = { name: 'db connects', message: 'Error: connect ECONNREFUSED 127.0.0.1:5432' };
    await sys.db.insert(schema.builderJobs).values([
      job({ status: 'failed', patch: 'p1', tests: [err], at: 5 }),
      job({ status: 'failed', patch: 'p2', tests: [err], at: 4 }),
      job({ status: 'failed', patch: 'p3', tests: [err, { name: 'clock' }], at: 3 }),
      job({ status: 'passed', patch: 'p3', at: 2 }),
      job({ repoId: api.id, taskId: t2.id, status: 'failed', patch: 'q1', tests: [{ name: 'boots', message: 'Error: connect ECONNREFUSED 10.0.0.9:6543' }], at: 1 }),
    ]);
    await runScan(deps, fx.org.id, now, { force: true });
    const f = await open();
    expect(f.filter((x) => x.kind === 'failing_test').map((x) => x.title)).toEqual(['db connects failed in 3 runs']);
    expect(f.filter((x) => x.kind === 'flaky_test').map((x) => x.title).sort()).toEqual(['clock is flaky', 'db connects is flaky']);
    expect(f.filter((x) => x.kind === 'repeated_failure')).toEqual([expect.objectContaining({ title: 'The same failure in 2 repositories' })]);
  });
});

describe('weekly digest', () => {
  it('reports health against the last digest and notifies the owner and admins', async () => {
    registries();
    await sys.db.insert(schema.agentPolicies).values({ orgId: fx.org.id, enabled: true });
    expect(await runDigest(sys.db, fx.org.id)).toMatchObject({ needAttention: 0, notified: 1 });
    await runScan(deps, fx.org.id);
    const d = await runDigest(sys.db, fx.org.id);
    expect(d).toMatchObject({ notified: 1 });
    const [run] = await sys.db.select().from(schema.groupAgentRuns).where(eq(schema.groupAgentRuns.id, d.runId!));
    expect(run!.payload).toMatchObject({ newFindings: 7, openFindings: 7, repos: expect.arrayContaining([expect.objectContaining({ name: 'acme/web', score: 66, previous: 100 })]) });
    const notes = await sys.db.select().from(schema.notifications).where(eq(schema.notifications.type, 'group_agent.digest'));
    expect(notes.map((x) => x.title).sort()).toEqual(['Weekly health: 2 repositories need attention', 'Weekly health: all repositories look healthy']);
    expect(notes.every((x) => x.link === '/o/acme/group-agent/digest' && x.userId === fx.owner.id)).toBe(true);
  });
});
