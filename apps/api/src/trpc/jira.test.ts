import { eq, schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, callerFor, createTestDeps, msw } from '../../test/harness';
import { buildServer } from '../server';

const JIRA = 'http://jira.test';
const h = createTestDeps();
const deps = { ...h.deps, env: { ...h.deps.env, JIRA_BASE_URL: JIRA, API_URL: 'http://api.test' } };
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
const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);

function jira() {
  const created: Record<string, unknown>[] = [];
  msw.use(
    http.get(`${JIRA}/rest/api/3/myself`, ({ request }) =>
      request.headers.get('authorization') === `Basic ${Buffer.from('bot@acme.com:good-jira-token').toString('base64')}` ? HttpResponse.json({ displayName: 'Acme Bot' }) : HttpResponse.json({}, { status: 401 }),
    ),
    http.get(`${JIRA}/rest/api/3/issue/:key`, ({ params }) =>
      params.key === 'WEB-404' ? HttpResponse.json({ errorMessages: ['Issue does not exist'] }, { status: 404 }) : HttpResponse.json({ key: params.key, fields: { summary: 'From Jira', status: { name: 'To Do' } } }),
    ),
    http.post(`${JIRA}/rest/api/3/issue`, async ({ request }) => {
      created.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ key: 'WEB-100' }, { status: 201 });
    }),
  );
  return created;
}

async function task(owner: { id: string }) {
  const [t] = await deps.sys
    .insert(schema.tasks)
    .values({ orgId: fx.org.id, repoId: fx.repo.id, number: 1, key: 'AD-1', title: 'Fix login', descriptionMd: 'It breaks.', mode: 'direct', branchMode: 'new', workBranch: 'b', ownerId: owner.id, createdBy: owner.id })
    .returning();
  return t!;
}

describe('Jira', () => {
  it('connects with checked credentials, stores the token encrypted, and shows the webhook to admins only', async () => {
    jira();
    const input = { site: 'acme', email: 'bot@acme.com', token: 'bad-jira-token', defaultProject: 'WEB' };
    expect(await code(as(admin).jira.connect(input))).toBe('BAD_GATEWAY');
    expect(await code(as(admin).jira.connect({ ...input, site: 'evil.com/x' }))).toBe('BAD_REQUEST');
    expect(await code(as(dev).jira.connect({ ...input, token: 'good-jira-token' }))).toBe('FORBIDDEN');
    expect(await as(admin).jira.connect({ ...input, token: 'good-jira-token' })).toEqual({ account: 'Acme Bot' });
    // Editing without a new token keeps the stored one.
    await as(admin).jira.connect({ ...input, token: undefined, defaultProject: 'OPS' });
    const [row] = await deps.sys.select().from(schema.jiraConnections);
    expect(row!.tokenEnc.toString('utf8')).not.toContain('good-jira-token');
    expect(await as(admin).jira.get()).toMatchObject({ site: 'acme', defaultProject: 'OPS', tokenLast4: 'oken', webhookUrl: `http://api.test/webhooks/jira/${fx.org.id}/${row!.webhookToken}` });
    expect((await as(dev).jira.get())!.webhookUrl).toBeNull();
  });

  it('links a task to an issue or creates one, for the owner or admins, and takes status updates from the webhook', async () => {
    const created = jira();
    await as(admin).jira.connect({ site: 'acme', email: 'bot@acme.com', token: 'good-jira-token', defaultProject: 'WEB' });
    const t = await task(dev);
    const other = await addMember(deps, fx.org.id, 'other', 'developer');
    expect(await code(as(other).jira.link({ key: t.key, issueKey: 'WEB-1' }))).toBe('FORBIDDEN');
    expect(await code(as(dev).jira.link({ key: t.key, issueKey: 'WEB-404' }))).toBe('BAD_GATEWAY');

    expect(await as(dev).jira.link({ key: t.key, create: true })).toMatchObject({ key: 'WEB-100', status: 'To Do' });
    expect(created[0]).toMatchObject({ fields: { project: { key: 'WEB' }, summary: 'Fix login', issuetype: { name: 'Task' } } });
    expect(JSON.stringify(created[0])).toContain('http://web.test/o/acme/tasks/AD-1');

    const [row] = await deps.sys.select().from(schema.jiraConnections);
    const hook = (token: string, body: object) => app.inject({ method: 'POST', url: `/webhooks/jira/${fx.org.id}/${token}`, payload: body });
    expect((await hook('x'.repeat(32), { webhookEvent: 'jira:issue_updated', issue: { key: 'WEB-100', fields: { status: { name: 'Done' } } } })).statusCode).toBe(404);
    expect((await hook(row!.webhookToken, { webhookEvent: 'jira:issue_updated', issue: { key: 'WEB-100', fields: { status: { name: 'Done' } } } })).json()).toMatchObject({ result: 'status' });
    expect((await deps.sys.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)))[0]).toMatchObject({ jiraIssueKey: 'WEB-100', jiraIssueStatus: 'Done' });

    await as(dev).jira.unlink({ key: t.key });
    expect((await deps.sys.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)))[0]!.jiraIssueKey).toBeNull();
  });
});
