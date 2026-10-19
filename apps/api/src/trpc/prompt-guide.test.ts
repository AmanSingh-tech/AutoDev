import { eq, schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, ANTHROPIC, API, callerFor, createTestDeps, msw } from '../../test/harness';

const h = createTestDeps();
const { deps } = h;
beforeAll(() => msw.listen({ onUnhandledRequest: 'error' }));
afterAll(async () => {
  msw.close();
  await h.close();
});
afterEach(() => msw.resetHandlers());

let fx: Awaited<ReturnType<typeof makeOrg>>;
let admin: { id: string };
let writer: { id: string };
let reader: { id: string };
beforeEach(async () => {
  await truncateAll(deps.sys);
  fx = await makeOrg(deps.sys, 'acme');
  admin = await addMember(deps, fx.org.id, 'admin', 'admin');
  writer = await addMember(deps, fx.org.id, 'writer', 'developer');
  reader = await addMember(deps, fx.org.id, 'reader', 'developer');
  // Mark access as fresh in the cache (key format from RepoAccessService), so no GitHub call is
  // needed. The admin and the writer can push; the reader can't.
  for (const u of [admin, writer, reader]) await deps.cache.set(`repo-access:fresh:${fx.org.id}:0:${u.id}`, '1', 3600);
  const fresh = { orgId: fx.org.id, repoId: fx.repo.id, fetchedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) };
  await deps.sys.insert(schema.userRepoAccess).values([
    { ...fresh, userId: admin.id, permission: 'admin' },
    { ...fresh, userId: writer.id, permission: 'push' },
    { ...fresh, userId: reader.id, permission: 'pull' },
  ]);
  msw.use(http.get(`${ANTHROPIC}/v1/models`, () => HttpResponse.json({ data: [], has_more: false })));
});

const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);
const draft = () => ({ repoId: fx.repo.id, title: 'Fix login', descriptionMd: 'It breaks.', acceptanceCriteriaMd: '' });
const addOrgKey = () => as(admin).llmKeys.create({ scope: 'org', provider: 'anthropic', label: 'k', apiKey: 'sk-ant-good-0123456789-ABCD' });

/** The model answers every call by calling `tool` with `input`. Records each request body. */
function modelAnswers(tool: string, input: unknown) {
  const bodies: { tools: { name: string }[]; model: string }[] = [];
  msw.use(
    http.post(`${ANTHROPIC}/v1/messages`, async ({ request }) => {
      bodies.push((await request.json()) as never);
      const events: [string, unknown][] = [
        ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 300, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: tool, input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 80 } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      // The provider streams, so the stub answers as server-sent events.
      return new HttpResponse(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }),
  );
  return bodies;
}

describe('promptGuide.check and rewrite', () => {
  it('are for people who can push to the repo', async () => {
    expect(await code(as(reader).promptGuide.check(draft()))).toBe('FORBIDDEN');
    expect(await code(as(reader).promptGuide.rewrite(draft()))).toBe('FORBIDDEN');
  });

  it('need a working key before they call the model', async () => {
    expect(await code(as(writer).promptGuide.check(draft()))).toBe('PRECONDITION_FAILED');
    expect(await code(as(writer).promptGuide.rewrite(draft()))).toBe('PRECONDITION_FAILED');
  });

  it('return the model check, metered under the prompt_check use case', async () => {
    await addOrgKey();
    const bodies = modelAnswers('submit_check', { score: 30, summary: 'Thin.', flags: ['missing_repro'], suggestions: ['Add steps.'] });

    const r = await as(writer).promptGuide.check(draft());

    expect(r).toEqual({ score: 30, summary: 'Thin.', flags: ['missing_repro'], suggestions: ['Add steps.'] });
    expect(bodies[0]!.tools.map((t) => t.name)).toEqual(['submit_check']);
    const usage = await deps.sys.select().from(schema.tokenUsage).where(eq(schema.tokenUsage.orgId, fx.org.id));
    expect(usage.map((u) => u.useCase)).toEqual(['prompt_check']);
  });

  it('returns the rewrite', async () => {
    await addOrgKey();
    modelAnswers('submit_rewrite', { title: 'Fix login on expired sessions', descriptionMd: 'Steps: [TODO]', acceptanceCriteriaMd: '- Redirects to sign-in' });
    expect((await as(writer).promptGuide.rewrite(draft())).title).toBe('Fix login on expired sessions');
  });
});

describe('promptGuide.templates', () => {
  const tpl = { name: 'Payments bug', kind: 'bug_fix' as const, descriptionMd: 'Check `src/payments`.', acceptanceCriteriaMd: '- Refund works' };

  it('lists the five built-ins, then the org’s own', async () => {
    await as(admin).promptGuide.templates.create(tpl);
    const list = await as(reader).promptGuide.templates.list();
    expect(list.map((t) => t.kind)).toEqual(['bug_fix', 'feature', 'refactor', 'add_tests', 'ui_change', 'bug_fix']);
    expect(list.at(-1)).toMatchObject({ builtIn: false, name: 'Payments bug' });
  });

  it('lets only admins change templates, and audits it', async () => {
    expect(await code(as(writer).promptGuide.templates.create(tpl))).toBe('FORBIDDEN');
    const t = await as(admin).promptGuide.templates.create(tpl);
    expect(await code(as(writer).promptGuide.templates.update({ id: t.id, name: 'x' }))).toBe('FORBIDDEN');
    expect(await code(as(writer).promptGuide.templates.delete({ id: t.id }))).toBe('FORBIDDEN');

    await as(admin).promptGuide.templates.update({ id: t.id, name: 'Payment bugs' });
    await as(admin).promptGuide.templates.delete({ id: t.id });
    const actions = (await deps.sys.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, fx.org.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['prompt_template.created', 'prompt_template.updated', 'prompt_template.deleted']));
  });

  it('rejects duplicate names in one org', async () => {
    const t = await as(admin).promptGuide.templates.create(tpl);
    expect(await code(as(admin).promptGuide.templates.create(tpl))).toBe('CONFLICT');
    const other = await as(admin).promptGuide.templates.create({ ...tpl, name: 'Other' });
    expect(await code(as(admin).promptGuide.templates.update({ id: other.id, name: tpl.name }))).toBe('CONFLICT');
    expect(await code(as(admin).promptGuide.templates.update({ id: t.id, name: tpl.name }))).toBe('OK');
  });

  it('cannot touch another org’s template', async () => {
    const other = await makeOrg(deps.sys, 'globex');
    const [foreign] = await deps.sys.insert(schema.promptTemplates).values({ orgId: other.org.id, name: 'Theirs', kind: 'feature' }).returning();
    expect(await code(as(admin).promptGuide.templates.update({ id: foreign!.id, name: 'Mine' }))).toBe('NOT_FOUND');
    expect(await code(as(admin).promptGuide.templates.delete({ id: foreign!.id }))).toBe('NOT_FOUND');
    expect((await as(admin).promptGuide.templates.list()).some((t) => t.name === 'Theirs')).toBe(false);
  });
});
