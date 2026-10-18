import { eq, schema, type TaskMode, type TaskStatus } from '@autodev/db';
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
let dev: { id: string };
let other: { id: string };
let viewer: { id: string };
beforeEach(async () => {
  await truncateAll(deps.sys);
  h.agentJobs.length = 0;
  fx = await makeOrg(deps.sys, 'acme');
  admin = await addMember(deps, fx.org.id, 'admin', 'admin');
  dev = await addMember(deps, fx.org.id, 'dev', 'developer');
  other = await addMember(deps, fx.org.id, 'other', 'developer');
  viewer = await addMember(deps, fx.org.id, 'viewer', 'viewer');
  msw.use(http.get(`${ANTHROPIC}/v1/models`, () => HttpResponse.json({ data: [], has_more: false })));
});

const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);

let n = 0;
async function taskIn(status: TaskStatus, mode: TaskMode = 'plan_lld') {
  n++;
  const [t] = await deps.sys
    .insert(schema.tasks)
    .values({ orgId: fx.org.id, repoId: fx.repo.id, number: n, key: `AD-${n}`, title: 'Greet', mode, branchMode: 'new', workBranch: `autodev/AD-${n}`, ownerId: dev.id, status })
    .returning();
  return t!;
}
async function pausedRun(taskId: string, phase: 'plan' | 'lld' | 'code', resumeStatus: TaskStatus | null = null) {
  const [r] = await deps.sys.insert(schema.agentRuns).values({ orgId: fx.org.id, taskId, phase, status: 'paused', resumeStatus }).returning();
  return r!;
}
async function doc(taskId: string, kind: 'plan' | 'lld', version = 1) {
  await deps.sys.insert(schema.taskDocuments).values({ orgId: fx.org.id, taskId, kind, version, contentMd: `# ${kind} v${version}` });
}

describe('agent.review', () => {
  it('approving the plan moves plan_lld tasks to design and plan_only tasks straight to code', async () => {
    const a = await taskIn('awaiting_plan_approval', 'plan_lld');
    await doc(a.id, 'plan');
    expect((await as(dev).agent.review({ key: a.key, kind: 'plan', version: 1, decision: 'approve' })).status).toBe('designing');

    const b = await taskIn('awaiting_plan_approval', 'plan_only');
    await doc(b.id, 'plan');
    expect((await as(admin).agent.review({ key: b.key, kind: 'plan', version: 1, decision: 'approve' })).status).toBe('coding');

    expect(h.agentJobs.map((j) => j.data.taskId)).toEqual([a.id, b.id]);
    const audit = await deps.sys.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'doc.approved'));
    expect(audit.map((x) => x.actorUserId)).toEqual([dev.id, admin.id]);
  });

  it('requires a comment to request changes, and sends the task back to that phase', async () => {
    const t = await taskIn('awaiting_lld_approval');
    await doc(t.id, 'lld');
    expect(await code(as(dev).agent.review({ key: t.key, kind: 'lld', version: 1, decision: 'request_changes' }))).toBe('BAD_REQUEST');
    expect((await as(dev).agent.review({ key: t.key, kind: 'lld', version: 1, decision: 'request_changes', comment: 'Cover the empty case' })).status).toBe('designing');
    const [d] = await deps.sys.select().from(schema.taskDocuments);
    expect(d).toMatchObject({ status: 'changes_requested', comment: 'Cover the empty case', reviewerId: dev.id });
  });

  it('rejecting ends the task without queueing work', async () => {
    const t = await taskIn('awaiting_plan_approval');
    await doc(t.id, 'plan');
    expect((await as(dev).agent.review({ key: t.key, kind: 'plan', version: 1, decision: 'reject', comment: 'Not needed' })).status).toBe('rejected');
    expect(h.agentJobs).toEqual([]);
  });

  it('allows only the owner or an admin, only the pending version, only while waiting', async () => {
    const t = await taskIn('awaiting_plan_approval');
    await doc(t.id, 'plan');
    expect(await code(as(other).agent.review({ key: t.key, kind: 'plan', version: 1, decision: 'approve' }))).toBe('FORBIDDEN');
    expect(await code(as(viewer).agent.review({ key: t.key, kind: 'plan', version: 1, decision: 'approve' }))).toBe('FORBIDDEN');
    expect(await code(as(dev).agent.review({ key: t.key, kind: 'plan', version: 2, decision: 'approve' }))).toBe('CONFLICT');
    expect(await code(as(dev).agent.review({ key: t.key, kind: 'lld', version: 1, decision: 'approve' }))).toBe('BAD_REQUEST');
  });
});

describe('agent.answer', () => {
  it('answers a question and returns the task to the phase it paused in', async () => {
    const t = await taskIn('needs_input');
    const run = await pausedRun(t.id, 'plan', 'planning');
    const [q] = await deps.sys.insert(schema.taskQuestions).values({ orgId: fx.org.id, taskId: t.id, agentRunId: run.id, kind: 'question', questionMd: 'Which?' }).returning();
    const { question } = await as(dev).agent.documents({ key: t.key });
    expect(question!.id).toBe(q!.id);
    expect((await as(dev).agent.answer({ key: t.key, questionId: q!.id, answer: 'The first' })).status).toBe('planning');
    expect(await code(as(dev).agent.answer({ key: t.key, questionId: q!.id, answer: 'again' }))).toBe('BAD_REQUEST');
    expect(h.agentJobs).toHaveLength(1);
  });

  it('needs an explicit allow/deny for a deviation, and audits it', async () => {
    const t = await taskIn('needs_input');
    const run = await pausedRun(t.id, 'code', 'coding');
    const [q] = await deps.sys.insert(schema.taskQuestions).values({ orgId: fx.org.id, taskId: t.id, agentRunId: run.id, kind: 'deviation', questionMd: 'Need to edit x.ts', paths: ['src/x.ts'] }).returning();
    expect(await code(as(dev).agent.answer({ key: t.key, questionId: q!.id, answer: 'ok' }))).toBe('BAD_REQUEST');
    expect((await as(dev).agent.answer({ key: t.key, questionId: q!.id, answer: 'ok', approve: true })).status).toBe('coding');
    const [saved] = await deps.sys.select().from(schema.taskQuestions);
    expect(saved!.approved).toBe(true);
    expect(await deps.sys.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'deviation.approved'))).toHaveLength(1);
  });
});

describe('resuming blocked_on_key', () => {
  it('refuses a manual resume without a key, and resumes automatically when an admin adds one', async () => {
    const t = await taskIn('blocked_on_key');
    await pausedRun(t.id, 'lld', 'designing');
    const err = await as(dev).agent.resume({ key: t.key }).catch((e) => e);
    expect(err.code).toBe('PRECONDITION_FAILED');

    await as(admin).llmKeys.create({ scope: 'org', provider: 'anthropic', label: 'k', apiKey: 'sk-ant-good-0123456789-ABCD' });
    const [cur] = await deps.sys.select().from(schema.tasks).where(eq(schema.tasks.id, t.id));
    expect(cur!.status).toBe('designing');
    expect(h.agentJobs.map((j) => j.data.taskId)).toEqual([t.id]);
  });

  it("does not resume another member's task with someone's personal key", async () => {
    const t = await taskIn('blocked_on_key');
    await pausedRun(t.id, 'plan', 'planning');
    await as(other).llmKeys.create({ scope: 'user', provider: 'anthropic', label: 'mine', apiKey: 'sk-ant-good-0123456789-ZZZZ' });
    const [cur] = await deps.sys.select().from(schema.tasks).where(eq(schema.tasks.id, t.id));
    expect(cur!.status).toBe('blocked_on_key');
  });
});

describe('changes and diffs', () => {
  it('lists changed files and returns before/after read with the caller token', async () => {
    const t = await taskIn('coding');
    const [ws] = await deps.sys.insert(schema.workspaces).values({ orgId: fx.org.id, taskId: t.id, repoId: fx.repo.id, baseSha: 'base1', baseRef: 'main' }).returning();
    await deps.sys.insert(schema.workspaceFiles).values({ workspaceId: ws!.id, orgId: fx.org.id, path: 'src/app.ts', op: 'modify', baseBlobSha: 'blob1', content: 'new\n' });
    await deps.vault.store(viewer.id, { accessToken: 'ghu_viewer', refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null });
    msw.use(
      http.get(`${API}/repos/acme/web/git/trees/base1`, () => HttpResponse.json({ truncated: false, tree: [{ path: 'src/app.ts', type: 'blob', sha: 'blob1', size: 4 }] })),
      http.get(`${API}/repos/acme/web/git/blobs/blob1`, ({ request }) => {
        expect(request.headers.get('authorization')).toBe('token ghu_viewer');
        return HttpResponse.json({ encoding: 'base64', content: Buffer.from('old\n').toString('base64') });
      }),
    );
    expect(await as(viewer).agent.changes({ key: t.key })).toMatchObject({ baseSha: 'base1', files: [{ path: 'src/app.ts', op: 'modify' }] });
    expect(await as(viewer).agent.fileDiff({ key: t.key, path: 'src/app.ts' })).toEqual({ before: 'old\n', after: 'new\n' });
    expect(await code(as(viewer).agent.fileDiff({ key: t.key, path: '../etc/passwd' }))).toBe('BAD_REQUEST');
  });
});
