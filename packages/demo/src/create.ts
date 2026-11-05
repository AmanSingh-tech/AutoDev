import { randomBytes } from 'node:crypto';
import type { KeyWrapper } from '@autodev/crypto';
import { and, eq, insertOrgWithOwner, schema, sql, transitionTask, type SystemDb, type TaskMode } from '@autodev/db';
import type { BlobStore } from '@autodev/storage';
import { uuidv7 } from 'uuidv7';
import { DemoAgent } from './agent';

const { installations, orgMembers, orgs, pullRequests, repos, taskDocuments, taskEvents, tasks, tokenUsage, userRepoAccess, users } = schema;

export interface CreateDemoDeps {
  sys: SystemDb;
  kms: KeyWrapper;
  blobs: BlobStore;
  webUrl: string;
}

const TEAMMATES = [
  { name: 'Priya Raman', login: 'priya', role: 'admin' as const },
  { name: 'Diego Alvarez', login: 'diego', role: 'developer' as const },
  { name: 'Mei Chen', login: 'mei', role: 'developer' as const },
  { name: 'Sam Okafor', login: 'sam', role: 'viewer' as const },
];
const REPOS = ['web', 'api', 'mobile'] as const;

type Stage = 'draft' | 'plan_review' | 'design_review' | 'pr_open' | 'merged';
interface Seed {
  title: string;
  description: string;
  repo: (typeof REPOS)[number];
  stage: Stage;
  mode: TaskMode;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  owner: 'you' | (typeof TEAMMATES)[number]['login'];
  daysAgo: number;
  byGroupAgent?: boolean;
}

const SEEDS: Seed[] = [
  {
    title: 'Return 404 instead of 500 for unknown organizations',
    description: 'GET /orgs/:slug throws when the slug does not exist, so clients see a 500.\n\n1. Request /orgs/does-not-exist\n2. See a 500\n\nExpected: a 404 with `{ "error": "not_found" }`.',
    repo: 'api',
    stage: 'plan_review',
    mode: 'plan_lld',
    priority: 'high',
    owner: 'you',
    daysAgo: 0,
  },
  {
    title: 'Add rate limiting to the public API',
    description: 'Limit each API key to 600 requests per minute and return 429 with a Retry-After header beyond that.',
    repo: 'api',
    stage: 'design_review',
    mode: 'plan_lld',
    priority: 'urgent',
    owner: 'priya',
    daysAgo: 1,
  },
  {
    title: 'Add an empty state to the projects list',
    description: 'When a workspace has no projects, the list is blank. Show a short explanation and a "Create project" button instead.',
    repo: 'web',
    stage: 'draft',
    mode: 'plan_only',
    priority: 'medium',
    owner: 'you',
    daysAgo: 0,
  },
  {
    title: 'Paginate the audit log endpoint',
    description: 'GET /audit returns every entry. Return 50 per page with a cursor.',
    repo: 'api',
    stage: 'pr_open',
    mode: 'plan_only',
    priority: 'medium',
    owner: 'diego',
    daysAgo: 2,
  },
  {
    title: 'Upgrade lodash to 4.17.21',
    description: 'lodash 4.17.20 has a prototype pollution advisory (CVE-2021-23337). Patch-level upgrade, no API changes.',
    repo: 'web',
    stage: 'pr_open',
    mode: 'direct',
    priority: 'high',
    owner: 'mei',
    daysAgo: 1,
    byGroupAgent: true,
  },
  {
    title: 'Dark mode for the settings page',
    description: 'The settings page ignores the dark theme. Use the theme tokens everywhere on it.',
    repo: 'web',
    stage: 'merged',
    mode: 'plan_only',
    priority: 'low',
    owner: 'mei',
    daysAgo: 5,
  },
  {
    title: 'Retry failed push notifications with backoff',
    description: 'Push notifications that fail with a 5xx are dropped. Retry up to 5 times with exponential backoff.',
    repo: 'mobile',
    stage: 'merged',
    mode: 'plan_lld',
    priority: 'medium',
    owner: 'diego',
    daysAgo: 8,
  },
];

/** A negative id can never collide with a real GitHub id. */
const fakeGithubId = () => -Number(BigInt('0x' + randomBytes(6).toString('hex')) % 1_000_000_000_000n) - 1;

/**
 * Creates a demo org for `user` ("Try the demo"): sample repos, teammates, tasks in every stage
 * with their plans, designs, diffs, test runs and pull requests, and a month of usage. Nothing in it
 * talks to GitHub or an AI provider. Returns the org's slug.
 */
export async function createDemoOrg(deps: CreateDemoDeps, user: { id: string; login: string }): Promise<{ orgId: string; slug: string }> {
  const { sys } = deps;
  const suffix = randomBytes(2).toString('hex');
  const login = `demo-${user.login.toLowerCase().replace(/[^a-z0-9-]/g, '')}-${suffix}`.slice(0, 39);

  const { org, people, repoRows } = await sys.transaction(async (tx) => {
    const org = await insertOrgWithOwner(tx, deps.kms, { githubAccountId: fakeGithubId(), githubLogin: login, accountType: 'Organization', name: 'Acme Cloud (demo)', ownerUserId: user.id });
    await tx
      .update(orgs)
      .set({ settings: sql`${orgs.settings} || ${JSON.stringify({ demo: true, onboarding: { dismissed: true, modelsConfirmed: true, inviteSkipped: true } })}::jsonb`, taskKeyPrefix: 'ACME' })
      .where(eq(orgs.id, org.id));
    const mates = await tx
      .insert(users)
      .values(TEAMMATES.map((m) => ({ githubUserId: fakeGithubId(), githubLogin: m.login, name: m.name })))
      .returning();
    await tx.insert(orgMembers).values(mates.map((u, i) => ({ orgId: org.id, userId: u.id, role: TEAMMATES[i]!.role })));
    const [inst] = await tx
      .insert(installations)
      .values({ orgId: org.id, githubInstallationId: fakeGithubId(), accountLogin: login, accountType: 'Organization', permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' }, installedByUserId: user.id })
      .returning();
    const repoRows = await tx
      .insert(repos)
      .values(REPOS.map((name) => ({ orgId: org.id, installationId: inst!.id, githubRepoId: fakeGithubId(), owner: 'acme', name, fullName: `acme/${name}`, defaultBranch: 'main', private: true, lastSyncedAt: new Date() })))
      .returning();
    // Demo access never expires and is never re-read from GitHub (see RepoAccessService).
    const far = new Date('2999-01-01');
    const everyone = [{ id: user.id, permission: 'admin' as const }, ...mates.map((u, i) => ({ id: u.id, permission: TEAMMATES[i]!.role === 'viewer' ? ('pull' as const) : ('push' as const) }))];
    await tx.insert(userRepoAccess).values(everyone.flatMap((p) => repoRows.map((r) => ({ orgId: org.id, userId: p.id, repoId: r.id, permission: p.permission, fetchedAt: new Date(), expiresAt: far }))));
    const people = new Map<string, string>([['you', user.id], ...TEAMMATES.map((m, i) => [m.login, mates[i]!.id] as [string, string])]);
    return { org, people, repoRows };
  });

  const agent = new DemoAgent({ sys, blobs: deps.blobs, webUrl: deps.webUrl, stepMs: 0 });
  let n = 0;
  for (const s of SEEDS) {
    n++;
    const repo = repoRows.find((r) => r.name === s.repo)!;
    const owner = people.get(s.owner)!;
    const key = `ACME-${n}`;
    const [t] = await sys
      .insert(tasks)
      .values({
        orgId: org.id,
        repoId: repo.id,
        number: n,
        key,
        title: s.title,
        descriptionMd: s.description,
        acceptanceCriteriaMd: '- Works as described\n- Covered by tests',
        priority: s.priority,
        mode: s.mode,
        branchMode: 'new',
        workBranch: `autodev/${key.toLowerCase()}`,
        ownerId: owner,
        createdBy: s.byGroupAgent ? null : owner,
        byGroupAgent: !!s.byGroupAgent,
        createPrOnCompletion: true,
      })
      .returning();
    await sys.insert(taskEvents).values({ orgId: org.id, taskId: t!.id, actorType: s.byGroupAgent ? 'agent' : 'user', actorUserId: s.byGroupAgent ? null : owner, type: 'created' });
    if (s.stage !== 'draft') await playThrough(sys, agent, t!.id, owner, s.stage);
    // Spread the history out, so dates on the board and dashboard look real.
    if (s.daysAgo) {
      const at = new Date(Date.now() - s.daysAgo * 86_400_000);
      await sys.update(tasks).set({ createdAt: at, updatedAt: s.stage === 'merged' ? new Date(at.getTime() + 6 * 3_600_000) : at }).where(eq(tasks.id, t!.id));
      await sys.update(pullRequests).set({ createdAt: new Date(at.getTime() + 2 * 3_600_000) }).where(eq(pullRequests.taskId, t!.id));
      if (s.stage === 'merged') {
        await sys.update(pullRequests).set({ mergedAt: new Date(at.getTime() + 6 * 3_600_000) }).where(eq(pullRequests.taskId, t!.id));
        await sys.update(tasks).set({ completedAt: new Date(at.getTime() + 6 * 3_600_000) }).where(eq(tasks.id, t!.id));
      }
    }
  }
  await sys.update(orgs).set({ taskSeq: n }).where(eq(orgs.id, org.id));
  await seedUsage(sys, org.id, [...people.values()], repoRows.map((r) => r.id));
  return { orgId: org.id, slug: org.slug };
}

/** Drives the demo agent with instant steps and auto-approvals, up to the wanted stage. */
async function playThrough(sys: SystemDb, agent: DemoAgent, taskId: string, reviewer: string, stage: Stage) {
  const load = async () => (await sys.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
  let t = await load();
  t = (await transitionTask(sys, t, 'queued', { type: 'user', userId: reviewer }, {})).task;
  for (let guard = 0; guard < 6; guard++) {
    await agent.process({ orgId: t.orgId, taskId });
    t = await load();
    if (t.status === 'awaiting_plan_approval') {
      if (stage === 'plan_review') return;
      await approve(sys, t, 'plan', reviewer);
      t = (await transitionTask(sys, t, t.mode === 'plan_lld' ? 'designing' : 'coding', { type: 'user', userId: reviewer }, { decision: 'approve' })).task;
    } else if (t.status === 'awaiting_lld_approval') {
      if (stage === 'design_review') return;
      await approve(sys, t, 'lld', reviewer);
      t = (await transitionTask(sys, t, 'coding', { type: 'user', userId: reviewer }, { decision: 'approve' })).task;
    } else break;
  }
  if (stage === 'merged' && t.status === 'pr_open') await mergeDemoPr(sys, t.id, reviewer);
}

async function approve(sys: SystemDb, t: { id: string }, kind: 'plan' | 'lld', reviewer: string) {
  await sys
    .update(taskDocuments)
    .set({ status: 'approved', reviewerId: reviewer, reviewedAt: new Date() })
    .where(and(eq(taskDocuments.taskId, t.id), eq(taskDocuments.kind, kind), eq(taskDocuments.status, 'pending_review')));
}

/** "Merge" in a demo org: what GitHub's merge webhook does for a real one. */
export async function mergeDemoPr(sys: SystemDb, taskId: string, userId: string) {
  const [t] = await sys.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t || t.status !== 'pr_open') return null;
  await sys.update(pullRequests).set({ state: 'merged', mergedAt: new Date() }).where(and(eq(pullRequests.taskId, taskId), eq(pullRequests.state, 'open')));
  await sys.update(tasks).set({ completedAt: new Date() }).where(eq(tasks.id, taskId));
  return (await transitionTask(sys, t, 'resolved', { type: 'user', userId }, { demo: true, merged: true })).task;
}

/** A month of agent usage, so Usage and Insights have numbers. Deterministic per org. */
async function seedUsage(sys: SystemDb, orgId: string, members: string[], repoIds: string[]) {
  let seed = 11;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rows: (typeof tokenUsage.$inferInsert)[] = [];
  const now = Date.now();
  for (let d = 29; d >= 0; d--) {
    const day = new Date(now - d * 86_400_000);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    for (let c = 0; c < 2 + Math.floor(rand() * 5); c++) {
      const input = 30_000 + Math.floor(rand() * 90_000);
      const output = 3_000 + Math.floor(rand() * 14_000);
      const cacheRead = Math.floor(rand() * 200_000);
      rows.push({
        id: uuidv7(),
        createdAt: new Date(day.getTime() - c * 3_600_000),
        orgId,
        userId: members[Math.floor(rand() * members.length)]!,
        repoId: repoIds[Math.floor(rand() * repoIds.length)]!,
        provider: 'anthropic',
        model: rand() > 0.3 ? 'claude-opus-5-5' : 'claude-sonnet-5-5',
        useCase: rand() > 0.15 ? 'agent' : 'chat',
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        costUsd: ((input * 5 + output * 25 + cacheRead * 0.5) / 1_000_000).toFixed(6),
      });
    }
  }
  if (rows.length) await sys.insert(tokenUsage).values(rows);
}
