import { encode } from '@auth/core/jwt';
import { eq, schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, AUTH_SECRET, callerFor, createTestDeps } from '../../test/harness';
import { buildServer } from '../server';
import { createCaller } from './router';

const h = createTestDeps();
const { deps } = h;
const app = await buildServer(deps, { logger: false });
afterAll(async () => {
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

const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const from = (u: { id: string }, ip: string) => createCaller({ deps, userId: u.id, orgId: fx.org.id, ip, userAgent: 'vitest' });
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);
const cookieFor = async (userId: string) => `authjs.session-token=${await encode({ token: { uid: userId }, secret: AUTH_SECRET, salt: 'authjs.session-token' })}`;

describe('IP allowlist', () => {
  it('normalizes entries, refuses a list without your own address, and then blocks other networks', async () => {
    expect(await code(as(admin).governance.setIpAllowlist({ entries: ['not-an-ip'] }))).toBe('BAD_REQUEST');
    const lockout = await as(admin).governance.setIpAllowlist({ entries: ['203.0.113.0/24'] }).catch((e) => e);
    expect(lockout.message).toMatch(/your own address \(127\.0\.0\.1\)/);

    expect(await as(admin).governance.setIpAllowlist({ entries: ['127.0.0.1', '10.1.2.3/8', '10.0.0.0/8'] })).toEqual({ entries: ['10.0.0.0/8', '127.0.0.1/32'] });
    expect(await code(from(dev, '10.20.30.40').tasks.list({}))).toBe('OK');
    expect(await code(from(dev, '::ffff:10.20.30.40').tasks.list({}))).toBe('OK');
    const blocked = await from(dev, '198.51.100.7').tasks.list({}).catch((e) => e);
    expect(blocked.code).toBe('FORBIDDEN');
    expect(blocked.message).toMatch(/isn't on this organization's IP allowlist/);
    expect(await code(createCaller({ deps, userId: dev.id, orgId: fx.org.id, ip: null, userAgent: null }).tasks.list({}))).toBe('FORBIDDEN');

    // The event stream is held to the same list.
    const res = await app.inject({ method: 'GET', url: `/events?org=${fx.org.id}&topics=org`, headers: { cookie: await cookieFor(dev.id), 'x-forwarded-for': '198.51.100.7' } });
    expect(res.statusCode).toBe(403);

    // Empty turns it off.
    await from(admin, '127.0.0.1').governance.setIpAllowlist({ entries: [] });
    expect(await code(from(dev, '198.51.100.7').tasks.list({}))).toBe('OK');
    expect(await deps.sys.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'org.ip_allowlist_updated'))).toHaveLength(2);
  });

  it('is for admins only', async () => {
    expect(await code(as(dev).governance.get())).toBe('FORBIDDEN');
    expect(await code(as(dev).governance.setIpAllowlist({ entries: [] }))).toBe('FORBIDDEN');
  });
});

describe('data region', () => {
  it('serves an org only from a deployment in its region', async () => {
    expect(await as(dev).tasks.list({}).then(() => 'OK')).toBe('OK');
    await deps.sys.update(schema.orgs).set({ dataRegion: 'eu' }).where(eq(schema.orgs.id, fx.org.id));
    const err = await callerFor({ ...deps, env: { ...deps.env, DATA_REGION: 'us' } }, dev.id, fx.org.id).tasks.list({}).catch((e) => e);
    expect(err.message).toMatch(/"eu" region/);
    expect(await code(callerFor({ ...deps, env: { ...deps.env, DATA_REGION: 'eu' } }, dev.id, fx.org.id).tasks.list({}))).toBe('OK');
  });
});

describe('retention and SIEM settings', () => {
  it('saves retention within limits and shows it back', async () => {
    expect(await code(as(admin).governance.setRetention({ chatRetentionDays: 3, agentTraceRetentionDays: null, notificationRetentionDays: null }))).toBe('BAD_REQUEST');
    await as(admin).governance.setRetention({ chatRetentionDays: 30, agentTraceRetentionDays: 180, notificationRetentionDays: null });
    expect(await as(admin).governance.get()).toMatchObject({ chatRetentionDays: 30, agentTraceRetentionDays: 180, notificationRetentionDays: null, dataRegion: 'us', yourIp: '127.0.0.1', siem: null });
  });

  it('stores the SIEM secret encrypted, needs https and a public address, and keeps the secret on edits', async () => {
    const s = as(admin).governance;
    expect(await code(s.setSiem({ url: 'http://siem.example.com/in', secret: 'x'.repeat(20) }))).toBe('BAD_REQUEST');
    expect(await code(s.setSiem({ url: 'https://10.0.0.5/in', secret: 'x'.repeat(20) }))).toBe('BAD_REQUEST');
    expect(await code(s.setSiem({ url: 'https://siem.example.com/in' }))).toBe('BAD_REQUEST');
    await s.setSiem({ url: 'https://siem.example.com/in', secret: 'super-secret-signing-key' });
    const [row] = await deps.sys.select().from(schema.siemDestinations);
    expect(row!.secretEnc.toString('utf8')).not.toContain('super-secret');
    expect(row!.cursorCreatedAt).toBeInstanceOf(Date);
    await s.setSiem({ url: 'https://siem.example.com/v2', enabled: false });
    expect((await s.get()).siem).toMatchObject({ url: 'https://siem.example.com/v2', secretLast4: '-key', enabled: false });
    await s.removeSiem();
    expect((await s.get()).siem).toBeNull();
  });
});

describe('audit export', () => {
  it('downloads the org’s audit log as CSV for admins, and records the download', async () => {
    await deps.sys.insert(schema.auditLog).values({ orgId: fx.org.id, actorType: 'user', actorUserId: admin.id, action: 'member.role_changed' });
    const get = async (u: { id: string }, q = '') => app.inject({ method: 'GET', url: `/audit/export?org=${fx.org.id}${q}`, headers: { cookie: await cookieFor(u.id) } });
    expect((await get(dev)).statusCode).toBe(403);
    const res = await get(admin);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="audit-.*\.csv"/);
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe('id,time,org_id,action,actor_type,actor_id,actor_login,target_type,target_id,ip,user_agent,metadata');
    expect(lines.slice(1).some((l) => l.includes('member.role_changed') && l.includes('admin'))).toBe(true);

    const nd = await get(admin, '&format=ndjson&from=2000-01-01');
    expect(nd.body.trim().split('\n').map((l) => JSON.parse(l).action)).toContain('audit.exported');
  });
});

describe('roles', () => {
  it('lets a billing manager handle billing whatever their role', async () => {
    const viewer = await addMember(deps, fx.org.id, 'finance', 'viewer');
    expect((await as(viewer).billing.status()).canManage).toBe(false);
    expect(await code(as(dev).members.setBillingManager({ userId: viewer.id, billingManager: true }))).toBe('FORBIDDEN');
    await as(admin).members.setBillingManager({ userId: viewer.id, billingManager: true });
    expect((await as(viewer).billing.status()).canManage).toBe(true);
    expect((await as(admin).members.list()).find((m) => m.userId === viewer.id)).toMatchObject({ billingManager: true });
  });

  it('lets team leads change their own team’s members, but not other teams or other leads', async () => {
    const lead = await addMember(deps, fx.org.id, 'lead', 'developer');
    const other = await addMember(deps, fx.org.id, 'other', 'developer');
    const core = await as(admin).teams.create({ name: 'Core' });
    const web = await as(admin).teams.create({ name: 'Web' });
    await as(admin).teams.addMember({ teamId: core.id, userId: lead.id });
    await as(admin).teams.setLead({ teamId: core.id, userId: lead.id, isLead: true });

    await as(lead).teams.addMember({ teamId: core.id, userId: dev.id });
    expect(await code(as(lead).teams.addMember({ teamId: web.id, userId: dev.id }))).toBe('FORBIDDEN');
    expect(await code(as(dev).teams.addMember({ teamId: core.id, userId: other.id }))).toBe('FORBIDDEN');

    await as(admin).teams.addMember({ teamId: core.id, userId: admin.id });
    await as(admin).teams.setLead({ teamId: core.id, userId: admin.id, isLead: true });
    expect(await code(as(lead).teams.removeMember({ teamId: core.id, userId: admin.id }))).toBe('FORBIDDEN');
    await as(lead).teams.removeMember({ teamId: core.id, userId: dev.id });
    const members = (await as(admin).teams.list()).find((t) => t.id === core.id)!;
    expect(JSON.stringify(members)).not.toContain(dev.id);
  });
});
