import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Envelope } from '@autodev/crypto';
import { createSystemDb, eq, orgKeyContext, schema } from '@autodev/db';
import { makeOrg, testKms, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertOutboundUrl, auditCsvHeader, auditCsvRow, isPrivateAddress, postOutbound, purgeOrg, pushOrgAudit, readAudit, siemSecretAad, signSiemBody } from './index';

const sys = createSystemDb(TEST_SYSTEM_URL);

/** A local SIEM receiver; tests set `status` and read what arrived. */
let server: Server;
let siemUrl = '';
let status = 200;
let received: { body: string; signature: string | undefined }[] = [];
beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ body, signature: req.headers['x-autodev-signature'] as string | undefined });
      res.writeHead(status).end(status === 200 ? 'ok' : 'nope');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  siemUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ingest`;
});
afterAll(async () => {
  server.close();
  await sys.close();
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  received = [];
  status = 200;
});

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

describe('retention', () => {
  it('purges chat and notifications older than the org’s settings, and keeps everything when unset', async () => {
    const [session] = await sys.db.insert(schema.chatSessions).values({ orgId: fx.org.id, repoId: fx.repo.id, userId: fx.owner.id, title: 't' }).returning();
    const [oldQ] = await sys.db.insert(schema.chatMessages).values({ orgId: fx.org.id, sessionId: session!.id, userId: fx.owner.id, role: 'user', content: 'old', createdAt: ago(40) }).returning();
    // A newer answer to the old question: the reply link is cleared, the answer kept.
    await sys.db.insert(schema.chatMessages).values({ orgId: fx.org.id, sessionId: session!.id, userId: fx.owner.id, role: 'assistant', content: 'new', replyToId: oldQ!.id, createdAt: ago(1) });
    await sys.db.insert(schema.notifications).values([
      { orgId: fx.org.id, userId: fx.owner.id, type: 'x', title: 'old', createdAt: ago(100) },
      { orgId: fx.org.id, userId: fx.owner.id, type: 'x', title: 'new' },
    ]);

    expect(await purgeOrg(sys.db, fx.org.id)).toMatchObject({ chatMessages: 0, notifications: 0 });

    await sys.db.update(schema.orgs).set({ chatRetentionDays: 30, notificationRetentionDays: 90 }).where(eq(schema.orgs.id, fx.org.id));
    expect(await purgeOrg(sys.db, fx.org.id)).toMatchObject({ chatMessages: 1, notifications: 1 });
    expect((await sys.db.select().from(schema.chatMessages)).map((m) => [m.content, m.replyToId])).toEqual([['new', null]]);
    expect((await sys.db.select().from(schema.notifications)).map((n) => n.title)).toEqual(['new']);
    // The audit log is never touched.
    await sys.db.insert(schema.auditLog).values({ orgId: fx.org.id, actorType: 'user', action: 'x', createdAt: ago(5000) });
    await purgeOrg(sys.db, fx.org.id);
    expect(await sys.db.select().from(schema.auditLog)).toHaveLength(1);
  });
});

describe('audit export', () => {
  it('reads the org’s entries in order with the actor’s login, and writes formula-safe CSV', async () => {
    await sys.db.insert(schema.auditLog).values([
      { orgId: fx.org.id, actorType: 'user', actorUserId: fx.owner.id, action: 'b', createdAt: ago(1), metadata: { note: '=HYPERLINK("x")' } },
      { orgId: fx.org.id, actorType: 'system', action: 'a', createdAt: ago(2) },
    ]);
    const other = await makeOrg(sys.db, 'other');
    await sys.db.insert(schema.auditLog).values({ orgId: other.org.id, actorType: 'user', action: 'theirs' });
    const rows = await readAudit(sys.db, fx.org.id, { limit: 10 });
    expect(rows.map((r) => r.action)).toEqual(['a', 'b']);
    expect(rows[1]).toMatchObject({ actor_login: 'acme-owner', actor_type: 'user' });
    expect(auditCsvHeader()).toBe('id,time,org_id,action,actor_type,actor_id,actor_login,target_type,target_id,ip,user_agent,metadata\n');
    expect(auditCsvRow({ ...rows[1]!, action: '=cmd()' })).toContain(`"'=cmd()"`);
  });
});

describe('SIEM push', () => {
  async function destination(url = siemUrl) {
    const env = new Envelope(testKms, fx.org.dataKeyWrapped, orgKeyContext(fx.org.id));
    await sys.db.insert(schema.siemDestinations).values({ orgId: fx.org.id, url, secretEnc: await env.encrypt('siem-secret', siemSecretAad(fx.org.id)), dataKeyVersion: 1, secretLast4: 'cret' });
  }
  const deps = { sys: sys.db, kms: testKms, outbound: { allowPrivate: true } };

  it('sends new entries once, signed, and resumes after a failure from the same place', async () => {
    await destination();
    await sys.db.insert(schema.auditLog).values([
      { orgId: fx.org.id, actorType: 'user', action: 'one', createdAt: ago(2) },
      { orgId: fx.org.id, actorType: 'user', action: 'two', createdAt: ago(1) },
    ]);
    expect(await pushOrgAudit(deps, fx.org.id)).toEqual({ orgId: fx.org.id, sent: 2 });
    const [batch] = received;
    expect(batch!.body.trim().split('\n').map((l) => JSON.parse(l).action)).toEqual(['one', 'two']);
    const t = Number(/t=(\d+)/.exec(batch!.signature!)![1]);
    expect(batch!.signature).toBe(signSiemBody('siem-secret', batch!.body, t));

    expect(await pushOrgAudit(deps, fx.org.id)).toEqual({ orgId: fx.org.id, sent: 0 });

    await sys.db.insert(schema.auditLog).values({ orgId: fx.org.id, actorType: 'user', action: 'three' });
    status = 500;
    expect(await pushOrgAudit(deps, fx.org.id)).toMatchObject({ sent: 0, error: 'HTTP 500: nope' });
    expect((await sys.db.select().from(schema.siemDestinations))[0]).toMatchObject({ failures: 1, lastError: 'HTTP 500: nope' });
    status = 200;
    expect(await pushOrgAudit(deps, fx.org.id)).toMatchObject({ sent: 1 });
    expect(received.at(-1)!.body).toContain('"three"');
    expect((await sys.db.select().from(schema.siemDestinations))[0]).toMatchObject({ failures: 0, lastError: null });
  });

  it('refuses private addresses unless allowed (development only)', async () => {
    await destination();
    await sys.db.insert(schema.auditLog).values({ orgId: fx.org.id, actorType: 'user', action: 'one' });
    expect((await pushOrgAudit({ sys: sys.db, kms: testKms }, fx.org.id)).error).toMatch(/https/);
    expect(received).toEqual([]);
  });
});

describe('outbound guard', () => {
  it('classifies private ranges, and checks URLs before saving and addresses before connecting', async () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1'] as const) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(() => assertOutboundUrl('http://siem.example.com')).toThrow(/https/);
    expect(() => assertOutboundUrl('https://u:p@siem.example.com')).toThrow(/credentials/);
    expect(() => assertOutboundUrl('https://169.254.169.254/latest')).toThrow(/private/);
    expect(() => assertOutboundUrl('https://[::1]/x')).toThrow(/private/);
    expect(assertOutboundUrl('https://siem.example.com/x').hostname).toBe('siem.example.com');
    // "localhost" passes the shape check but is refused once it resolves to 127.0.0.1.
    await expect(postOutbound('https://localhost:1/x', '{}', {})).rejects.toThrow(/private address/);
  });
});
