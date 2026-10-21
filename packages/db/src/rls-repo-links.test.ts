import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, truncateAll } from '../test/fixtures';
import { TEST_APP_URL, TEST_SYSTEM_URL } from '../test/env';
import { createAppDb, createSystemDb, withOrg } from './client';
import { orgMembers, repoLinks, repos, tasks, userRepoAccess, users } from './schema';

const sys = createSystemDb(TEST_SYSTEM_URL);
const app = createAppDb(TEST_APP_URL);
afterAll(async () => {
  await Promise.all([sys.close(), app.close()]);
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let mobile: { id: string };
let api: { id: string };
let webOnly: { id: string };
let nobody: { id: string };
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  const made = await sys.db
    .insert(repos)
    .values(['mobile', 'api'].map((name, i) => ({ orgId: fx.org.id, installationId: fx.installation.id, githubRepoId: 7_000_000 + i + Math.floor(Math.random() * 1e5), owner: 'acme', name, fullName: `acme/${name}`, defaultBranch: 'main', private: true })))
    .returning();
  [mobile, api] = [made[0]!, made[1]!];
  const people = await sys.db.insert(users).values([{ githubUserId: 9_400_001, githubLogin: 'web-only' }, { githubUserId: 9_400_002, githubLogin: 'nobody' }]).returning();
  [webOnly, nobody] = [people[0]!, people[1]!];
  await sys.db.insert(orgMembers).values(people.map((u) => ({ orgId: fx.org.id, userId: u.id, role: 'developer' as const })));
  await sys.db.insert(userRepoAccess).values({ orgId: fx.org.id, repoId: fx.repo.id, userId: webOnly.id, permission: 'push', fetchedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
  await sys.db.insert(repoLinks).values([
    { orgId: fx.org.id, sourceRepoId: fx.repo.id, targetRepoId: mobile.id, mappingNotesMd: 'web ↔ mobile' },
    { orgId: fx.org.id, sourceRepoId: mobile.id, targetRepoId: api.id },
  ]);
});

const as = <T>(u: { id: string }, fn: Parameters<typeof withOrg<T>>[3]) => withOrg(app.db, fx.org.id, u.id, fn);

describe('repo_links', () => {
  it('shows a link to people who can access either of its repos', async () => {
    const seen = await as(webOnly, (tx) => tx.select().from(repoLinks));
    expect(seen.map((l) => l.targetRepoId)).toEqual([mobile.id]);
    expect(await as(nobody, (tx) => tx.select().from(repoLinks))).toEqual([]);
  });

  it('allows one link per pair of repos, whichever way round, and never a repo to itself', async () => {
    await expect(sys.db.insert(repoLinks).values({ orgId: fx.org.id, sourceRepoId: mobile.id, targetRepoId: fx.repo.id })).rejects.toThrow(/repo_links_pair_uq/);
    await expect(sys.db.insert(repoLinks).values({ orgId: fx.org.id, sourceRepoId: api.id, targetRepoId: api.id })).rejects.toThrow(/repo_links_not_self/);
  });

  it('can only be written by people who can access both repos, inside the org', async () => {
    await expect(as(webOnly, (tx) => tx.insert(repoLinks).values({ orgId: fx.org.id, sourceRepoId: api.id, targetRepoId: fx.repo.id }))).rejects.toThrow();
    const other = await makeOrg(sys.db, 'globex');
    await expect(as(webOnly, (tx) => tx.insert(repoLinks).values({ orgId: other.org.id, sourceRepoId: fx.repo.id, targetRepoId: other.repo.id }))).rejects.toThrow(/row-level security/);
  });

  it('keeps a task from being its own source', async () => {
    const [t] = await sys.db.insert(tasks).values({ orgId: fx.org.id, repoId: fx.repo.id, number: 1, key: 'AD-1', title: 'x', mode: 'direct', branchMode: 'new', workBranch: 'autodev/AD-1-x', ownerId: fx.owner.id }).returning();
    await expect(sys.db.update(tasks).set({ sourceTaskId: t!.id }).where(eqId(t!.id))).rejects.toThrow(/tasks_not_self_source/);
  });
});

import { eq } from 'drizzle-orm';
const eqId = (id: string) => eq(tasks.id, id);
