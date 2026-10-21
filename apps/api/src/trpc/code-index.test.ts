import { eq, schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, callerFor, createTestDeps, testCfg } from '../../test/harness';
import { buildServer } from '../server';

const h = createTestDeps();
const { deps } = h;
const server = await buildServer(deps, { logger: false });
afterAll(async () => {
  await server.close();
  await h.close();
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let dev: { id: string };
let admin: { id: string };
beforeEach(async () => {
  await truncateAll(deps.sys);
  h.codeIndexJobs.length = 0;
  fx = await makeOrg(deps.sys, 'acme');
  dev = await addMember(deps, fx.org.id, 'dev', 'developer');
  admin = await addMember(deps, fx.org.id, 'admin', 'admin');
  for (const u of [dev, admin])
    await deps.sys.insert(schema.userRepoAccess).values({ userId: u.id, repoId: fx.repo.id, orgId: fx.org.id, permission: 'pull', fetchedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
});

const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: { code?: string }) => e.code,
  );

describe('storeCodeIndex setting', () => {
  it('is off by default, admin only, audited, and queues a build or a purge when it changes', async () => {
    expect((await as(dev).orgs.current()).storeCodeIndex).toBe(false);
    expect(await code(as(dev).orgs.updateSettings({ storeCodeIndex: true }))).toBe('FORBIDDEN');

    expect((await as(admin).orgs.updateSettings({ storeCodeIndex: true })).storeCodeIndex).toBe(true);
    expect(h.codeIndexJobs).toEqual([{ name: 'org', data: { kind: 'org', orgId: fx.org.id }, jobId: undefined, delay: undefined }]);
    // Other settings stored in the same JSON survive.
    const [org] = await deps.sys.select({ settings: schema.orgs.settings }).from(schema.orgs).where(eq(schema.orgs.id, fx.org.id));
    expect(org!.settings).toMatchObject({ storeCodeIndex: true });

    // Saving other settings doesn't queue anything.
    await as(admin).orgs.updateSettings({ maxFixCycles: 2 });
    expect(h.codeIndexJobs).toHaveLength(1);
    expect((await as(dev).orgs.current()).storeCodeIndex).toBe(true);

    await as(admin).orgs.updateSettings({ storeCodeIndex: false });
    expect(h.codeIndexJobs[1]).toMatchObject({ name: 'purge', data: { kind: 'purge', orgId: fx.org.id } });
    const audits = await deps.sys.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'org.settings_updated'));
    expect(audits.map((a) => (a.metadata as { changes: Record<string, unknown> }).changes.storeCodeIndex).filter(Boolean)).toEqual([
      { from: false, to: true },
      { from: true, to: false },
    ]);
  });
});

describe('codeIndex router', () => {
  it('reports the state to people with access, and nothing to people without', async () => {
    expect(await as(dev).codeIndex.status({ repoId: fx.repo.id })).toEqual({ enabled: false, canReindex: false, state: null });
    await as(admin).orgs.updateSettings({ storeCodeIndex: true });
    await deps.sys.insert(schema.codeIndexState).values({ repoId: fx.repo.id, orgId: fx.org.id, status: 'ready', commitSha: 'abc', files: 12, chunks: 40 });
    expect(await as(dev).codeIndex.status({ repoId: fx.repo.id })).toMatchObject({ enabled: true, canReindex: false, state: { status: 'ready', commitSha: 'abc', files: 12, chunks: 40 } });
    expect((await as(admin).codeIndex.status({ repoId: fx.repo.id })).canReindex).toBe(true);

    const outsider = await addMember(deps, fx.org.id, 'outsider', 'developer');
    expect(await code(as(outsider).codeIndex.status({ repoId: fx.repo.id }))).toBe('FORBIDDEN');
  });

  it('lets admins rebuild a repo index when it is on, with one job per repo', async () => {
    expect(await code(as(admin).codeIndex.reindex({ repoId: fx.repo.id }))).toBe('PRECONDITION_FAILED');
    await as(admin).orgs.updateSettings({ storeCodeIndex: true });
    h.codeIndexJobs.length = 0;
    expect(await code(as(dev).codeIndex.reindex({ repoId: fx.repo.id }))).toBe('FORBIDDEN');
    await as(admin).codeIndex.reindex({ repoId: fx.repo.id });
    expect(h.codeIndexJobs).toEqual([{ name: 'repo', data: { kind: 'repo', orgId: fx.org.id, repoId: fx.repo.id }, jobId: `repo-${fx.repo.id}`, delay: undefined }]);
    expect(await deps.sys.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'code_index.reindex_requested'))).toHaveLength(1);
  });
});

describe('push webhooks', () => {
  function push(ref: string, githubRepoId = fx.repo.githubRepoId) {
    const body = JSON.stringify({ ref, installation: { id: fx.installation.githubInstallationId }, repository: { id: githubRepoId } });
    return server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': 'sha256=' + createHmac('sha256', testCfg.webhookSecret).update(body).digest('hex') },
      payload: body,
    });
  }

  it('queues a delayed run for pushes to the default branch only, when the index is on', async () => {
    expect((await push('refs/heads/main')).json()).toEqual({ result: 'ignored:code_index_off' });
    await as(admin).orgs.updateSettings({ storeCodeIndex: true });
    h.codeIndexJobs.length = 0;

    expect((await push('refs/heads/feature')).json()).toEqual({ result: 'ignored:not_default_branch' });
    expect((await push('refs/tags/v1')).json()).toEqual({ result: 'ignored:not_default_branch' });
    expect((await push('refs/heads/main', 424242)).json()).toEqual({ result: 'ignored:unknown_repo' });
    expect(h.codeIndexJobs).toEqual([]);

    expect((await push('refs/heads/main')).json()).toEqual({ result: 'code_index:queued' });
    expect(h.codeIndexJobs).toEqual([{ name: 'repo', data: { kind: 'repo', orgId: fx.org.id, repoId: fx.repo.id }, jobId: `repo-${fx.repo.id}`, delay: 30_000 }]);
  });
});
