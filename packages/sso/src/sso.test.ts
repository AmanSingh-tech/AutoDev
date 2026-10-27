import { createSystemDb, eq, schema } from '@autodev/db';
import { makeOrg, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyWorkosEvent, linkIdentity, readState, signState, signWorkosPayload, ssoCheck, verifyWorkosWebhook, WorkosClient, WorkosSignatureError } from './index';

const sys = createSystemDb(TEST_SYSTEM_URL);
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await sys.close();
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let dev: { id: string };
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  const [u] = await sys.db.insert(schema.users).values({ githubUserId: 9_700_001, githubLogin: 'dev' }).returning();
  dev = u!;
  await sys.db.insert(schema.orgMembers).values({ orgId: fx.org.id, userId: dev.id, role: 'developer' });
  await sys.db.insert(schema.orgSso).values({ orgId: fx.org.id, workosOrganizationId: 'org_acme', ssoRequired: true, sessionHours: 24 });
});

const profile = { id: 'prof_1', idp_id: 'idp_1', email: 'Dev@Acme.com', organization_id: 'org_acme' };
const HOUR = 3_600_000;

describe('ssoCheck and linkIdentity', () => {
  it('requires a recent SSO sign-in from members (not owners) once SSO is required', async () => {
    expect(await ssoCheck(sys.db, fx.org.id, fx.owner.id, 'owner')).toEqual({ required: false });
    expect(await ssoCheck(sys.db, fx.org.id, dev.id, 'developer')).toEqual({ required: true, ok: false, reason: 'not_linked' });

    expect(await linkIdentity(sys.db, { orgId: fx.org.id, userId: dev.id, profile })).toEqual({ linked: true });
    expect(await ssoCheck(sys.db, fx.org.id, dev.id, 'developer')).toEqual({ required: true, ok: true });
    expect(await ssoCheck(sys.db, fx.org.id, dev.id, 'developer', new Date(Date.now() + 25 * HOUR))).toMatchObject({ ok: false, reason: 'expired' });

    await sys.db.update(schema.orgSso).set({ ssoRequired: false });
    expect(await ssoCheck(sys.db, fx.org.id, dev.id, 'developer', new Date(Date.now() + 25 * HOUR))).toEqual({ required: false });
  });

  it('refuses profiles from another WorkOS organization, and one IdP account for two users', async () => {
    await expect(linkIdentity(sys.db, { orgId: fx.org.id, userId: dev.id, profile: { ...profile, organization_id: 'org_evil' } })).rejects.toThrow(/another organization/);
    await linkIdentity(sys.db, { orgId: fx.org.id, userId: dev.id, profile });
    await expect(linkIdentity(sys.db, { orgId: fx.org.id, userId: fx.owner.id, profile })).rejects.toThrow(/already linked/);
    const [identity] = await sys.db.select().from(schema.ssoIdentities);
    expect(identity).toMatchObject({ email: 'dev@acme.com', userId: dev.id });
  });
});

describe('directory sync', () => {
  const event = (type: string, data: Record<string, unknown>, id = `evt_${Math.random()}`) => ({ id, event: type, data });
  const user = (state: string) => ({ id: 'dir_user_1', directory_id: 'dir_1', organization_id: 'org_acme', idp_id: 'idp_1', emails: [{ primary: true, value: 'dev@acme.com' }], first_name: 'Dev', last_name: 'One', state });

  it('records the directory, and removes a linked member when the directory deactivates them', async () => {
    const removed: string[] = [];
    const deps = { sys: sys.db, onRemoved: async (_o: string, u: string) => void removed.push(u) };
    expect(await applyWorkosEvent(deps, event('dsync.activated', { id: 'dir_1', organization_id: 'org_acme' }))).toBe('directory:connected');
    expect((await sys.db.select().from(schema.orgSso))[0]!.workosDirectoryId).toBe('dir_1');

    // Not linked yet: only recorded.
    expect(await applyWorkosEvent(deps, event('dsync.user.created', user('active')))).toBe('directory_user:active');
    await linkIdentity(sys.db, { orgId: fx.org.id, userId: dev.id, profile });
    expect((await sys.db.select().from(schema.directoryUsers))[0]).toMatchObject({ userId: dev.id, name: 'Dev One', email: 'dev@acme.com' });

    const e = event('dsync.user.updated', user('inactive'), 'evt_off');
    expect(await applyWorkosEvent(deps, e)).toBe('member_removed');
    expect(await applyWorkosEvent(deps, e)).toBe('duplicate');
    const [m] = await sys.db.select().from(schema.orgMembers).where(eq(schema.orgMembers.userId, dev.id));
    expect(m!.status).toBe('removed');
    expect(removed).toEqual([dev.id]);
    expect(await sys.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'member.deprovisioned'))).toHaveLength(1);
  });

  it('never removes an owner, and ignores events for unknown organizations', async () => {
    await applyWorkosEvent({ sys: sys.db }, event('dsync.activated', { id: 'dir_1', organization_id: 'org_acme' }));
    await linkIdentity(sys.db, { orgId: fx.org.id, userId: fx.owner.id, profile: { ...profile, id: 'prof_o', idp_id: 'idp_o', email: 'owner@acme.com' } });
    expect(await applyWorkosEvent({ sys: sys.db }, event('dsync.user.deleted', { ...user('active'), idp_id: 'idp_o', emails: [{ primary: true, value: 'owner@acme.com' }] }))).toBe('owner_kept');
    expect(await applyWorkosEvent({ sys: sys.db }, event('dsync.user.updated', { ...user('inactive'), directory_id: 'dir_x', organization_id: 'org_x' }))).toBe('unknown_org');
  });
});

describe('WorkOS plumbing', () => {
  it('verifies webhook signatures and state', () => {
    const raw = JSON.stringify({ id: 'evt_1', event: 'dsync.user.created', data: {} });
    expect(verifyWorkosWebhook('wh_secret', Buffer.from(raw), signWorkosPayload('wh_secret', raw)).id).toBe('evt_1');
    expect(() => verifyWorkosWebhook('wh_secret', Buffer.from(raw), signWorkosPayload('other', raw))).toThrow(WorkosSignatureError);
    expect(() => verifyWorkosWebhook('wh_secret', Buffer.from(raw), signWorkosPayload('wh_secret', raw, Date.now() - 600_000))).toThrow(/tolerance/);

    const state = signState('s', { orgId: 'o', userId: 'u', returnTo: '/o/acme' });
    expect(readState('s', state)).toEqual({ orgId: 'o', userId: 'u', returnTo: '/o/acme' });
    expect(readState('other', state)).toBeNull();
    expect(readState('s', state, Date.now() + 11 * 60_000)).toBeNull();
    expect(readState('s', `${state.split('.')[0]}x.${state.split('.')[1]}`)).toBeNull();
  });

  it('builds the authorization URL and exchanges the code with the client secret', async () => {
    const client = new WorkosClient({ apiKey: 'sk_workos', clientId: 'client_1', apiUrl: 'http://workos.test' });
    const url = new URL(client.authorizationUrl({ organization: 'org_acme', redirectUri: 'http://web.test/api/sso/callback', state: 'st' }));
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'client_1', redirect_uri: 'http://web.test/api/sso/callback', response_type: 'code', organization: 'org_acme', state: 'st' });
    server.use(
      http.post('http://workos.test/sso/token', async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get('client_secret')).toBe('sk_workos');
        return body.get('code') === 'good' ? HttpResponse.json({ profile }) : HttpResponse.json({ error_description: 'Invalid code' }, { status: 400 });
      }),
    );
    expect((await client.profile('good')).email).toBe('Dev@Acme.com');
    await expect(client.profile('bad')).rejects.toThrow('Invalid code');
  });
});
