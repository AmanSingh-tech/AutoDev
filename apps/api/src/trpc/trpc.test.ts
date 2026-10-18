import { eq, schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, API, callerFor, createTestDeps, msw } from '../../test/harness';

const h = createTestDeps();
const { deps } = h;

beforeAll(() => msw.listen({ onUnhandledRequest: 'error' }));
afterEach(() => msw.resetHandlers());
afterAll(async () => {
  msw.close();
  await h.close();
});

let acme: Awaited<ReturnType<typeof makeOrg>>;
let globex: Awaited<ReturnType<typeof makeOrg>>;
beforeEach(async () => {
  await truncateAll(deps.sys);
  acme = await makeOrg(deps.sys, 'acme');
  globex = await makeOrg(deps.sys, 'globex');
});

const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);

describe('auth and tenancy guards', () => {
  it('rejects anonymous callers', async () => {
    expect(await code(callerFor(deps, null, null).me.get())).toBe('UNAUTHORIZED');
  });

  it('rejects an org the caller is not a member of', async () => {
    expect(await code(callerFor(deps, acme.owner.id, globex.org.id).orgs.current())).toBe('FORBIDDEN');
  });

  it('rejects a removed member', async () => {
    const dev = await addMember(deps, acme.org.id, 'dev', 'developer');
    await deps.sys.update(schema.orgMembers).set({ status: 'removed' }).where(eq(schema.orgMembers.userId, dev.id));
    expect(await code(callerFor(deps, dev.id, acme.org.id).orgs.current())).toBe('FORBIDDEN');
  });

  it('lists only active memberships in me.get', async () => {
    await deps.sys.insert(schema.orgMembers).values({ orgId: globex.org.id, userId: acme.owner.id, role: 'viewer', status: 'removed' });
    const me = await callerFor(deps, acme.owner.id, null).me.get();
    expect(me.orgs.map((o) => [o.slug, o.role])).toEqual([['acme', 'owner']]);
  });
});

describe('roles', () => {
  it('lets viewers and developers read but not change settings', async () => {
    const viewer = await addMember(deps, acme.org.id, 'viewer', 'viewer');
    const caller = callerFor(deps, viewer.id, acme.org.id);
    expect((await caller.orgs.current()).myRole).toBe('viewer');
    expect(await code(caller.orgs.updateSettings({ staleBranchDays: 5 }))).toBe('FORBIDDEN');
  });

  it('lets an admin change settings and records the diff in the audit log', async () => {
    const admin = await addMember(deps, acme.org.id, 'admin', 'admin');
    const updated = await callerFor(deps, admin.id, acme.org.id).orgs.updateSettings({
      defaultTaskMode: 'plan_only',
      staleBranchDays: 7,
    });
    expect(updated.defaultTaskMode).toBe('plan_only');
    const [entry] = await deps.sys.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'org.settings_updated'));
    expect(entry!.actorUserId).toBe(admin.id);
    expect(entry!.metadata).toMatchObject({ changes: { staleBranchDays: { from: 3, to: 7 } } });
  });

  it('stops admins from creating owners or demoting other admins', async () => {
    const admin = await addMember(deps, acme.org.id, 'admin', 'admin');
    const admin2 = await addMember(deps, acme.org.id, 'admin2', 'admin');
    const dev = await addMember(deps, acme.org.id, 'dev', 'developer');
    const caller = callerFor(deps, admin.id, acme.org.id);
    expect(await code(caller.members.setRole({ userId: dev.id, role: 'owner' }))).toBe('FORBIDDEN');
    expect(await code(caller.members.setRole({ userId: admin2.id, role: 'viewer' }))).toBe('FORBIDDEN');
    expect(await code(caller.members.setRole({ userId: dev.id, role: 'admin' }))).toBe('OK');
  });

  it('never leaves an org without an owner', async () => {
    const owner = callerFor(deps, acme.owner.id, acme.org.id);
    expect(await code(owner.members.setRole({ userId: acme.owner.id, role: 'admin' }))).toBe('BAD_REQUEST');
    expect(await code(owner.members.remove({ userId: acme.owner.id }))).toBe('BAD_REQUEST');

    const second = await addMember(deps, acme.org.id, 'second', 'developer');
    await owner.members.setRole({ userId: second.id, role: 'owner' });
    expect(await code(owner.members.setRole({ userId: acme.owner.id, role: 'admin' }))).toBe('OK');
  });

  it('cannot touch members of another org even with a valid user id', async () => {
    const admin = await addMember(deps, acme.org.id, 'admin', 'admin');
    expect(await code(callerFor(deps, admin.id, acme.org.id).members.remove({ userId: globex.owner.id }))).toBe('NOT_FOUND');
  });

  it('manages teams with org members only', async () => {
    const caller = callerFor(deps, acme.owner.id, acme.org.id);
    const team = await caller.teams.create({ name: 'Platform Team' });
    expect(team.slug).toBe('platform-team');
    expect(await code(caller.teams.create({ name: 'platform team' }))).toBe('CONFLICT');
    expect(await code(caller.teams.addMember({ teamId: team.id, userId: globex.owner.id }))).toBe('BAD_REQUEST');
    await caller.teams.addMember({ teamId: team.id, userId: acme.owner.id });
    const [listed] = await caller.teams.list();
    expect(listed!.members.map((m) => m.githubLogin)).toEqual(['acme-owner']);
  });
});

describe('repos.list', () => {
  it('returns only writable repos for the caller', async () => {
    await deps.vault.store(acme.owner.id, { accessToken: 'ghu_t', refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null });
    msw.use(
      http.get(`${API}/user/installations/:id/repositories`, () =>
        HttpResponse.json({
          total_count: 2,
          repositories: [
            { id: acme.repo.githubRepoId, name: 'web', full_name: 'acme/web', owner: { login: 'acme' }, default_branch: 'main', private: true, archived: false, permissions: { push: true } },
            { id: 555, name: 'docs', full_name: 'acme/docs', owner: { login: 'acme' }, default_branch: 'main', private: true, archived: false, permissions: { pull: true } },
          ],
        }),
      ),
    );
    const list = await callerFor(deps, acme.owner.id, acme.org.id).repos.list();
    expect(list.map((r) => r.fullName)).toEqual(['acme/web']);
  });

  it('maps a missing GitHub token to a re-auth error', async () => {
    const err = await callerFor(deps, acme.owner.id, acme.org.id).repos.list().catch((e) => e);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toBe('GITHUB_REAUTH_REQUIRED');
  });
});
