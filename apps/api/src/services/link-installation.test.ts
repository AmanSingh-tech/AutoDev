import { eq, schema } from '@autodev/db';
import { truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API, createTestDeps, msw } from '../../test/harness';
import { linkInstallation } from './link-installation';

const h = createTestDeps();
beforeAll(() => msw.listen({ onUnhandledRequest: 'error' }));
afterEach(() => msw.resetHandlers());
afterAll(async () => {
  msw.close();
  await h.close();
});

let userId: string;
beforeEach(async () => {
  await truncateAll(h.deps.sys);
  h.jobs.length = 0;
  const [u] = await h.deps.sys.insert(schema.users).values({ githubUserId: 10, githubLogin: 'alice' }).returning();
  userId = u!.id;
  await h.deps.vault.store(userId, { accessToken: 'ghu_a', refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null });
});

function github(opts: { installations: object[]; orgRole?: 'admin' | 'member' }) {
  msw.use(
    http.get(`${API}/user/installations`, () =>
      HttpResponse.json({ total_count: opts.installations.length, installations: opts.installations }),
    ),
    http.get(`${API}/user/memberships/orgs/:org`, () =>
      opts.orgRole ? HttpResponse.json({ state: 'active', role: opts.orgRole }) : new HttpResponse(null, { status: 404 }),
    ),
  );
}

const orgInstall = { id: 77, target_type: 'Organization', account: { id: 500, login: 'Acme' }, permissions: { contents: 'write' }, events: ['push'] };

describe('linkInstallation', () => {
  it('creates the org with the GitHub org admin as owner and queues a repo sync', async () => {
    github({ installations: [orgInstall], orgRole: 'admin' });
    const res = await linkInstallation(h.deps, userId, 77);
    expect(res).toEqual({ ok: true, orgSlug: 'acme', created: true });

    const [org] = await h.deps.sys.select().from(schema.orgs).where(eq(schema.orgs.githubAccountId, 500));
    expect(org!.dataKeyWrapped.length).toBeGreaterThan(32);
    const [m] = await h.deps.sys.select().from(schema.orgMembers).where(eq(schema.orgMembers.orgId, org!.id));
    expect(m!.role).toBe('owner');
    expect(h.jobs).toHaveLength(1);
  });

  it('refuses to create an org for a plain GitHub org member', async () => {
    github({ installations: [orgInstall], orgRole: 'member' });
    expect(await linkInstallation(h.deps, userId, 77)).toEqual({ ok: false, reason: 'not_github_admin' });
    expect(await h.deps.sys.select().from(schema.orgs)).toEqual([]);
  });

  it('refuses an installation id the user cannot see (tampered URL)', async () => {
    github({ installations: [orgInstall], orgRole: 'admin' });
    expect(await linkInstallation(h.deps, userId, 999)).toEqual({ ok: false, reason: 'installation_not_visible' });
  });

  it('lets a personal-account owner link their own account', async () => {
    github({ installations: [{ id: 88, target_type: 'User', account: { id: 10, login: 'alice' } }] });
    expect(await linkInstallation(h.deps, userId, 88)).toMatchObject({ ok: true, orgSlug: 'alice' });
  });
});
