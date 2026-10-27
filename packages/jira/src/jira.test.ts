import { Envelope } from '@autodev/crypto';
import { createSystemDb, eq, orgKeyContext, schema } from '@autodev/db';
import { makeOrg, testKms, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyJiraWebhook, JiraClient, jiraTokenAad, pushTaskUpdates } from './index';

const sys = createSystemDb(TEST_SYSTEM_URL);
const server = setupServer();
const JIRA = 'http://jira.test';
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await sys.close();
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  const env = new Envelope(testKms, fx.org.dataKeyWrapped, orgKeyContext(fx.org.id));
  await sys.db.insert(schema.jiraConnections).values({
    orgId: fx.org.id,
    site: 'acme',
    email: 'bot@acme.com',
    tokenEnc: await env.encrypt('jira-token-secret', jiraTokenAad(fx.org.id)),
    dataKeyVersion: 1,
    tokenLast4: 'cret',
    defaultProject: 'WEB',
    webhookToken: 'hook-token-123',
  });
});

async function task(status: 'coding' | 'pr_open', issue: string | null = 'WEB-7') {
  const [t] = await sys.db
    .insert(schema.tasks)
    .values({ orgId: fx.org.id, repoId: fx.repo.id, number: 1, key: 'AD-1', title: 'Fix login', descriptionMd: 'x', mode: 'direct', branchMode: 'new', workBranch: 'b', ownerId: fx.owner.id, createdBy: fx.owner.id, status, jiraIssueKey: issue })
    .returning();
  return t!;
}

const deps = { sys: sys.db, kms: testKms, webUrl: 'http://web.test', baseUrl: JIRA };

describe('Jira status sync', () => {
  it('comments once per status change, with the PR link, using the decrypted token', async () => {
    const comments: { key: string; text: string; auth: string | null }[] = [];
    server.use(
      http.post(`${JIRA}/rest/api/3/issue/:key/comment`, async ({ request, params }) => {
        comments.push({ key: params.key as string, text: JSON.stringify(await request.json()), auth: request.headers.get('authorization') });
        return HttpResponse.json({ id: '1' }, { status: 201 });
      }),
    );
    const t = await task('coding');
    expect(await pushTaskUpdates(deps, fx.org.id)).toEqual({ orgId: fx.org.id, commented: 1 });
    expect(comments[0]!.key).toBe('WEB-7');
    expect(comments[0]!.auth).toBe(`Basic ${Buffer.from('bot@acme.com:jira-token-secret').toString('base64')}`);
    expect(comments[0]!.text).toContain('is now coding');
    expect(comments[0]!.text).toContain('http://web.test/o/acme/tasks/AD-1');
    expect((await pushTaskUpdates(deps, fx.org.id)).commented).toBe(0);

    await sys.db.update(schema.tasks).set({ status: 'pr_open' }).where(eq(schema.tasks.id, t.id));
    await sys.db.insert(schema.pullRequests).values({ orgId: fx.org.id, taskId: t.id, repoId: fx.repo.id, githubPrId: 1, number: 42, url: 'https://github.test/acme/web/pull/42', headBranch: 'b', baseBranch: 'main', createdBy: 'user' });
    await pushTaskUpdates(deps, fx.org.id);
    expect(comments[1]!.text).toContain('pull request open');
    expect(comments[1]!.text).toContain('https://github.test/acme/web/pull/42');
  });

  it('records errors on the connection and skips issues that are gone', async () => {
    await task('coding');
    server.use(http.post(`${JIRA}/rest/api/3/issue/:key/comment`, () => HttpResponse.json({ errorMessages: ['boom'] }, { status: 500 })));
    expect(await pushTaskUpdates(deps, fx.org.id)).toMatchObject({ commented: 0, error: 'boom' });
    expect((await sys.db.select().from(schema.jiraConnections))[0]!.lastError).toBe('boom');

    server.use(http.post(`${JIRA}/rest/api/3/issue/:key/comment`, () => HttpResponse.json({}, { status: 404 })));
    expect(await pushTaskUpdates(deps, fx.org.id)).toEqual({ orgId: fx.org.id, commented: 0 });
    expect((await sys.db.select().from(schema.tasks))[0]!.jiraSyncedStatus).toBe('coding');
  });
});

describe('Jira webhook', () => {
  it('needs the org’s token, keeps the issue status, and unlinks deleted issues', async () => {
    await task('coding');
    const update = { webhookEvent: 'jira:issue_updated', issue: { key: 'WEB-7', fields: { status: { name: 'In Review' } } } };
    expect(await applyJiraWebhook(sys.db, fx.org.id, 'wrong-token-12', update)).toBe('forbidden');
    expect(await applyJiraWebhook(sys.db, fx.org.id, 'hook-token-123', update)).toBe('status');
    expect((await sys.db.select().from(schema.tasks))[0]!.jiraIssueStatus).toBe('In Review');
    expect(await applyJiraWebhook(sys.db, fx.org.id, 'hook-token-123', { webhookEvent: 'jira:issue_deleted', issue: { key: 'WEB-7' } })).toBe('unlinked');
    expect((await sys.db.select().from(schema.tasks))[0]!.jiraIssueKey).toBeNull();
  });
});

describe('JiraClient', () => {
  it('only talks to <site>.atlassian.net and checks keys before calling', async () => {
    expect(() => new JiraClient({ site: 'evil.com/x', email: 'a', token: 'b' })).toThrow(/site name/);
    const c = new JiraClient({ site: 'acme', email: 'a@b.c', token: 't' });
    expect(c.siteUrl).toBe('https://acme.atlassian.net');
    await expect(c.issue('../admin')).rejects.toThrow(/issue key/);
    server.use(http.get('https://acme.atlassian.net/rest/api/3/issue/WEB-1', () => HttpResponse.json({ key: 'WEB-1', fields: { summary: 'S', status: { name: 'To Do' } } })));
    expect(await c.issue('WEB-1')).toEqual({ key: 'WEB-1', summary: 'S', status: 'To Do', url: 'https://acme.atlassian.net/browse/WEB-1' });
  });
});
