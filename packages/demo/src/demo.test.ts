import { createSystemDb, eq, schema, transitionTask } from '@autodev/db';
import { makeOrg, testKms, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { MemoryBlobStore } from '@autodev/storage';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDemoOrg, DemoAgent, isDemoOrg, mergeDemoPr } from './index';

const sys = createSystemDb(TEST_SYSTEM_URL);
afterAll(() => sys.close());
const blobs = new MemoryBlobStore();
const deps = { sys: sys.db, kms: testKms, blobs, webUrl: 'http://web.test' };

let user: { id: string; githubLogin: string };
beforeEach(async () => {
  await truncateAll(sys.db);
  const fx = await makeOrg(sys.db, 'real');
  user = fx.owner;
});

describe('demo org', () => {
  it('creates a believable org: repos, teammates, tasks in every stage, PRs and usage', async () => {
    const { orgId, slug } = await createDemoOrg(deps, { id: user.id, login: user.githubLogin });
    expect(slug).toMatch(/^demo-real-owner-[0-9a-f]{4}$/);
    expect(await isDemoOrg(sys.db, orgId)).toBe(true);
    const tasks = await sys.db.select().from(schema.tasks).where(eq(schema.tasks.orgId, orgId));
    expect(tasks.map((t) => t.status).sort()).toEqual(['awaiting_lld_approval', 'awaiting_plan_approval', 'draft', 'needs_input', 'pr_open', 'pr_open', 'resolved', 'resolved']);
    const merged = tasks.find((t) => t.status === 'resolved')!;
    expect(merged.summaryMd).toContain('All tests pass');
    const prs = await sys.db.select().from(schema.pullRequests).where(eq(schema.pullRequests.orgId, orgId));
    expect(prs).toHaveLength(4);
    expect(prs.filter((p) => p.state === 'merged')).toHaveLength(2);
    expect(prs.some((p) => p.createdBy === 'group_agent')).toBe(true);
    const jobs = await sys.db.select().from(schema.builderJobs).where(eq(schema.builderJobs.orgId, orgId));
    expect(jobs.filter((j) => j.status === 'failed')).toHaveLength(1);
    expect(jobs.every((j) => j.logHash)).toBe(true);
    expect(await sys.db.select().from(schema.recommendations).where(eq(schema.recommendations.orgId, orgId))).toHaveLength(3);
    expect((await sys.db.select().from(schema.taskQuestions).where(eq(schema.taskQuestions.orgId, orgId)))[0]!.answeredAt).toBeNull();
    expect((await blobs.get(jobs[0]!.logHash!))!.toString()).toContain('passed');
    expect((await sys.db.select().from(schema.tokenUsage).where(eq(schema.tokenUsage.orgId, orgId))).length).toBeGreaterThan(20);
    expect(await isDemoOrg(sys.db, (await makeOrg(sys.db, 'other')).org.id)).toBe(false);
  });

  it('runs a new task through plan, approval, code, tests and PR, then merges it', async () => {
    const { orgId } = await createDemoOrg(deps, { id: user.id, login: user.githubLogin });
    const agent = new DemoAgent({ ...deps, stepMs: 0 });
    let [t] = await sys.db.select().from(schema.tasks).where(eq(schema.tasks.status, 'draft'));
    t = (await transitionTask(sys.db, t!, 'queued', { type: 'user', userId: user.id })).task;
    expect(await agent.process({ orgId, taskId: t.id })).toBe('plan');
    const [plan] = await sys.db.select().from(schema.taskDocuments).where(eq(schema.taskDocuments.taskId, t.id));
    expect(plan).toMatchObject({ kind: 'plan', version: 1, status: 'pending_review' });
    expect(plan!.contentMd).toContain('## Plan: Add an empty state to the projects list');

    // Changes requested: the next plan is v2 and mentions the feedback.
    await sys.db.update(schema.taskDocuments).set({ status: 'changes_requested', comment: 'Also handle the loading state' }).where(eq(schema.taskDocuments.id, plan!.id));
    t = (await transitionTask(sys.db, (await sys.db.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)))[0]!, 'planning', { type: 'user', userId: user.id })).task;
    await agent.process({ orgId, taskId: t.id });
    const docs = await sys.db.select().from(schema.taskDocuments).where(eq(schema.taskDocuments.taskId, t.id));
    expect(docs.find((d) => d.version === 2)!.contentMd).toContain('Also handle the loading state');

    t = (await transitionTask(sys.db, (await sys.db.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)))[0]!, 'coding', { type: 'user', userId: user.id })).task;
    expect(await agent.process({ orgId, taskId: t.id })).toBe('pr_open');
    const files = await sys.db.select().from(schema.workspaceFiles).where(eq(schema.workspaceFiles.orgId, orgId));
    expect(files.some((f) => f.path.endsWith('.test.tsx'))).toBe(true);
    expect((await mergeDemoPr(sys.db, t.id, user.id))!.status).toBe('resolved');
    const steps = await sys.db.select().from(schema.agentSteps).where(eq(schema.agentSteps.taskId, t.id));
    expect(steps.length).toBeGreaterThan(5);
  });
});

describe('demo chat', () => {
  it('answers from the sample repo and says it is a demo answer', async () => {
    const { demoAnswer } = await import('./index');
    expect(demoAnswer('How are tests organised?', 'web')).toContain('Vitest');
    expect(demoAnswer('Where is routing handled?', 'api')).toContain('`src/server.ts`');
    expect(demoAnswer('Explain error handling', 'api')).toContain('Demo answer');
  });
});
