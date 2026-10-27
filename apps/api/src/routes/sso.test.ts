import { encode } from '@auth/core/jwt';
import { eq, schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { signWorkosPayload } from '@autodev/sso';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, AUTH_SECRET, callerFor, createTestDeps, msw, WORKOS } from '../../test/harness';
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

let fx: Awaited<ReturnType<typeof makeOrg>>;
let admin: { id: string };
let dev: { id: string };
beforeEach(async () => {
  await truncateAll(deps.sys);
  fx = await makeOrg(deps.sys, 'acme');
  admin = await addMember(deps, fx.org.id, 'admin', 'admin');
  dev = await addMember(deps, fx.org.id, 'dev', 'developer');
});

const cookieFor = async (userId: string) => `authjs.session-token=${await encode({ token: { uid: userId }, secret: AUTH_SECRET, salt: 'authjs.session-token' })}`;
const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);

function workosApi(email = 'dev@acme.com', organization = 'org_acme') {
  msw.use(
    http.post(`${WORKOS}/organizations`, () => HttpResponse.json({ id: 'org_acme' })),
    http.post(`${WORKOS}/portal/generate_link`, async ({ request }) => {
      const body = (await request.json()) as { intent: string; organization: string };
      return HttpResponse.json({ link: `https://setup.workos.test/${body.intent}?org=${body.organization}` });
    }),
    http.post(`${WORKOS}/sso/token`, () => HttpResponse.json({ profile: { id: `prof_${email}`, idp_id: `idp_${email}`, email, organization_id: organization } })),
  );
}

/** Runs start → (IdP) → callback for `u`, returning the final redirect. */
async function signInWithSso(u: { id: string }, returnTo = '/o/acme/tasks') {
  const cookie = await cookieFor(u.id);
  const start = await app.inject({ method: 'GET', url: `/sso/start?org=${fx.org.id}&returnTo=${encodeURIComponent(returnTo)}`, headers: { cookie } });
  expect(start.statusCode).toBe(302);
  const authorize = new URL(start.headers.location as string);
  expect(authorize.origin + authorize.pathname).toBe(`${WORKOS}/sso/authorize`);
  const state = authorize.searchParams.get('state')!;
  const done = await app.inject({ method: 'GET', url: `/sso/callback?code=c&state=${encodeURIComponent(state)}`, headers: { cookie } });
  return { state, location: done.headers.location as string };
}

describe('single sign-on', () => {
  it('sets up through the WorkOS portal, links members, and then requires a recent SSO sign-in', async () => {
    workosApi();
    expect((await as(admin).sso.portalLink({ intent: 'sso' })).link).toBe('https://setup.workos.test/sso?org=org_acme');
    // An admin can't require SSO before signing in with it themselves.
    expect(await code(as(admin).sso.update({ ssoRequired: true, sessionHours: 8 }))).toBe('BAD_REQUEST');

    workosApi('admin@acme.com');
    await signInWithSso(admin);
    await as(admin).sso.update({ ssoRequired: true, sessionHours: 8 });

    const blocked = await as(dev).tasks.list({}).catch((e) => e);
    expect(blocked.code).toBe('FORBIDDEN');
    expect(blocked.message).toMatch(/single sign-on/);
    // Owners are never locked out.
    expect(await code(callerFor(deps, fx.owner.id, fx.org.id).tasks.list({}))).toBe('OK');

    workosApi('dev@acme.com');
    const { location } = await signInWithSso(dev);
    expect(location).toBe('http://web.test/o/acme/tasks');
    expect(await code(as(dev).tasks.list({}))).toBe('OK');
    expect(await as(dev).sso.get()).toMatchObject({ ssoRequired: true, sessionHours: 8, linkedMembers: 2, mine: { email: 'dev@acme.com' } });
  });

  it('refuses a callback finished by someone else, a foreign IdP, and redirects outside the app', async () => {
    workosApi();
    await as(admin).sso.portalLink({ intent: 'sso' });
    const cookie = await cookieFor(dev.id);
    const start = await app.inject({ method: 'GET', url: `/sso/start?org=${fx.org.id}&returnTo=${encodeURIComponent('https://evil.test')}`, headers: { cookie } });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const stolen = await app.inject({ method: 'GET', url: `/sso/callback?code=c&state=${encodeURIComponent(state)}`, headers: { cookie: await cookieFor(admin.id) } });
    expect(stolen.headers.location).toMatch(/sso_error=Sign%20in%20to%20AutoDev%20as%20the%20same%20person/);

    workosApi('dev@other.com', 'org_other');
    const foreign = await app.inject({ method: 'GET', url: `/sso/callback?code=c&state=${encodeURIComponent(state)}`, headers: { cookie } });
    expect(foreign.headers.location).toMatch(/sso_error=.*another%20organization/);
    expect(await deps.sys.select().from(schema.ssoIdentities)).toEqual([]);

    workosApi('dev@acme.com');
    const ok = await app.inject({ method: 'GET', url: `/sso/callback?code=c&state=${encodeURIComponent(state)}`, headers: { cookie } });
    expect(ok.headers.location).toBe('http://web.test/o/acme');
  });
});

describe('directory sync webhook', () => {
  it('accepts signed events and removes members deactivated in the directory', async () => {
    workosApi('dev@acme.com');
    await as(admin).sso.portalLink({ intent: 'dsync' });
    await signInWithSso(dev);
    const send = (body: object, secret = 'wh_harness') => {
      const raw = JSON.stringify(body);
      return app.inject({ method: 'POST', url: '/webhooks/workos', payload: raw, headers: { 'content-type': 'application/json', 'workos-signature': signWorkosPayload(secret, raw) } });
    };
    expect((await send({ id: 'e0', event: 'dsync.activated', data: { id: 'dir_1', organization_id: 'org_acme' } }, 'wrong')).statusCode).toBe(400);
    expect((await send({ id: 'e1', event: 'dsync.activated', data: { id: 'dir_1', organization_id: 'org_acme' } })).json()).toMatchObject({ result: 'directory:connected' });
    const res = await send({ id: 'e2', event: 'dsync.user.updated', data: { id: 'du_1', directory_id: 'dir_1', idp_id: 'idp_dev@acme.com', emails: [{ primary: true, value: 'dev@acme.com' }], state: 'inactive' } });
    expect(res.json()).toMatchObject({ result: 'member_removed' });
    const [m] = await deps.sys.select().from(schema.orgMembers).where(eq(schema.orgMembers.userId, dev.id));
    expect(m!.status).toBe('removed');
  });
});
