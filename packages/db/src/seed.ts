/**
 * Seeds a demo org so the UI has data without a real GitHub App. Idempotent.
 * The GitHub IDs are fake (900000+) and won't collide with real accounts in dev.
 */
import { loadEnv, cryptoEnv, dbEnv } from '@autodev/config';
import { createKeyWrapper } from '@autodev/crypto';
import { config } from 'dotenv';
import { and, eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { createSystemDb } from './client';
import { insertOrgWithOwner } from './ops/orgs';
import { uuidv7 } from 'uuidv7';
import { budgets, installations, orgMembers, orgs, repos, tasks, taskEvents, tokenUsage, userRepoAccess, users, workspaceFiles, workspaces } from './schema';
import type { TaskStatus } from './schema/enums';
import type { OrgRole, RepoPermission } from './schema/enums';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
const env = loadEnv(dbEnv.merge(cryptoEnv));

const PEOPLE: { login: string; name: string; role: OrgRole }[] = [
  { login: 'demo-owner', name: 'Olivia Owner', role: 'owner' },
  { login: 'demo-admin', name: 'Adrian Admin', role: 'admin' },
  { login: 'demo-dev', name: 'Devi Developer', role: 'developer' },
  { login: 'demo-viewer', name: 'Victor Viewer', role: 'viewer' },
];

/** Mixed permissions for demo-dev: the repo list should show 3 of these 4. */
const REPOS: { name: string; devPermission: RepoPermission }[] = [
  { name: 'web', devPermission: 'push' },
  { name: 'api', devPermission: 'admin' },
  { name: 'infra', devPermission: 'maintain' },
  { name: 'docs', devPermission: 'pull' },
];

async function main() {
  const { db, close } = createSystemDb(env.DATABASE_URL_SYSTEM);
  const kms = createKeyWrapper(env);
  try {
    const existing = await db.select().from(orgs).where(eq(orgs.slug, 'acme-demo'));
    if (existing.length) {
      await seedUsage(db, existing[0]!.id);
      await seedTasks(db, existing[0]!.id);
      await seedChange(db, existing[0]!.id);
      await softBudget(db, existing[0]!.id);
      console.log('demo org already seeded');
      return;
    }

    await db.transaction(async (tx) => {
      const people = await tx
        .insert(users)
        .values(
          PEOPLE.map((p, i) => ({
            githubUserId: 900_001 + i,
            githubLogin: p.login,
            name: p.name,
            email: `${p.login}@example.com`,
            avatarUrl: `https://avatars.githubusercontent.com/u/${900_001 + i}`,
          })),
        )
        .returning();
      const byLogin = new Map(people.map((u) => [u.githubLogin, u]));

      const org = await insertOrgWithOwner(tx, kms, {
        githubAccountId: 900_100,
        githubLogin: 'acme-demo',
        accountType: 'Organization',
        name: 'Acme (demo)',
        ownerUserId: byLogin.get('demo-owner')!.id,
      });
      await tx.insert(orgMembers).values(
        PEOPLE.filter((p) => p.role !== 'owner').map((p) => ({
          orgId: org.id,
          userId: byLogin.get(p.login)!.id,
          role: p.role,
        })),
      );

      const [inst] = await tx
        .insert(installations)
        .values({
          orgId: org.id,
          githubInstallationId: 900_200,
          accountLogin: 'acme-demo',
          accountType: 'Organization',
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read', members: 'read' },
          installedByUserId: byLogin.get('demo-owner')!.id,
        })
        .returning();

      const repoRows = await tx
        .insert(repos)
        .values(
          REPOS.map((r, i) => ({
            orgId: org.id,
            installationId: inst!.id,
            githubRepoId: 900_300 + i,
            owner: 'acme-demo',
            name: r.name,
            fullName: `acme-demo/${r.name}`,
            defaultBranch: 'main',
            private: true,
            lastSyncedAt: new Date(),
          })),
        )
        .returning();

      // A far-future expiry so the demo list works without contacting GitHub.
      const far = new Date('2999-01-01');
      await tx.insert(userRepoAccess).values(
        repoRows.map((repo, i) => ({
          userId: byLogin.get('demo-dev')!.id,
          repoId: repo.id,
          orgId: org.id,
          permission: REPOS[i]!.devPermission,
          fetchedAt: new Date(),
          expiresAt: far,
        })),
      );
    });
    const [org] = await db.select().from(orgs).where(eq(orgs.slug, 'acme-demo'));
    await seedUsage(db, org!.id);
    await seedTasks(db, org!.id);
    await seedChange(db, org!.id);
    await softBudget(db, org!.id);
    console.log('seeded demo org acme-demo');
  } finally {
    await close();
  }
}

/**
 * End-to-end runs keep adding (mock) usage, so the demo org's $25 budget would eventually block every
 * AI call and fail unrelated tests. With SEED_SOFT_BUDGET=1 (set by tools/e2e only) the budget still
 * exists, so its meter shows, but it only warns.
 */
async function softBudget(db: ReturnType<typeof createSystemDb>['db'], orgId: string) {
  if (process.env.SEED_SOFT_BUDGET !== '1') return;
  await db.update(budgets).set({ hardBlock: false }).where(and(eq(budgets.orgId, orgId), eq(budgets.scope, 'org')));
}

/** Sample metered usage for this month plus an org budget, so the usage and budget screens have data. */
async function seedUsage(db: ReturnType<typeof createSystemDb>['db'], orgId: string) {
  const any = await db.select({ id: tokenUsage.id }).from(tokenUsage).where(eq(tokenUsage.orgId, orgId)).limit(1);
  if (any.length) return;
  const members = await db
    .select({ id: users.id, login: users.githubLogin })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(eq(orgMembers.orgId, orgId));
  const repoRows = await db.select({ id: repos.id }).from(repos).where(eq(repos.orgId, orgId));
  const now = new Date();
  const rows: (typeof tokenUsage.$inferInsert)[] = [];
  // Deterministic pseudo-random: the same demo data every time.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let day = 1; day <= now.getUTCDate(); day++) {
    const calls = Math.floor(rand() * 6);
    for (let c = 0; c < calls; c++) {
      const who = members[Math.floor(rand() * members.length)]!;
      const input = 20_000 + Math.floor(rand() * 80_000);
      const output = 2_000 + Math.floor(rand() * 12_000);
      const cacheRead = Math.floor(rand() * 150_000);
      const cost = (input * 4 + output * 20 + cacheRead * 0.2) / 1_000_000;
      rows.push({
        id: uuidv7(),
        createdAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, 9 + c)),
        orgId,
        userId: who.id,
        repoId: repoRows[Math.floor(rand() * repoRows.length)]!.id,
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        useCase: 'agent',
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        costUsd: cost.toFixed(6),
      });
    }
  }
  if (rows.length) await db.insert(tokenUsage).values(rows);
  await db.insert(budgets).values({ orgId, scope: 'org', limitUsd: '25.00', softPct: 80 }).onConflictDoNothing();
}

/** A few tasks across the board's columns on acme-demo/api, so the board isn't empty. */
async function seedTasks(db: ReturnType<typeof createSystemDb>['db'], orgId: string) {
  const any = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.orgId, orgId)).limit(1);
  if (any.length) return;
  const [repo] = await db.select().from(repos).where(eq(repos.fullName, 'acme-demo/api'));
  const [owner] = await db.select().from(users).where(eq(users.githubLogin, 'demo-owner'));
  const [admin] = await db.select().from(users).where(eq(users.githubLogin, 'demo-admin'));
  const demo: { title: string; status: TaskStatus; priority: 'low' | 'medium' | 'high' | 'urgent'; who: string }[] = [
    { title: 'Add rate limiting to the public API', status: 'draft', priority: 'high', who: owner!.id },
    { title: 'Document the webhook retry policy', status: 'draft', priority: 'low', who: admin!.id },
    { title: 'Return 404 instead of 500 for unknown orgs', status: 'awaiting_plan_approval', priority: 'medium', who: owner!.id },
    { title: 'Migrate session store to Redis', status: 'coding', priority: 'urgent', who: admin!.id },
    { title: 'Paginate the audit log endpoint', status: 'pr_open', priority: 'medium', who: owner!.id },
    { title: 'Remove the legacy v1 auth routes', status: 'resolved', priority: 'low', who: admin!.id },
  ];
  await db.transaction(async (tx) => {
    for (const [i, d] of demo.entries()) {
      const n = i + 1;
      const key = `AD-${n}`;
      const slug = d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-+$/, '');
      const [t] = await tx
        .insert(tasks)
        .values({
          orgId,
          repoId: repo!.id,
          number: n,
          key,
          title: d.title,
          descriptionMd: 'Seeded demo task.',
          acceptanceCriteriaMd: '- Behaves as described\n- Tests cover the change',
          priority: d.priority,
          status: d.status,
          mode: 'plan_lld',
          branchMode: 'new',
          workBranch: `autodev/${key}-${slug}`,
          ownerId: d.who,
          createdBy: d.who,
          completedAt: d.status === 'resolved' ? new Date() : null,
        })
        .returning();
      await tx.insert(taskEvents).values({ orgId, taskId: t!.id, actorType: 'user', actorUserId: d.who, type: 'created' });
    }
    await tx.update(orgs).set({ taskSeq: demo.length }).where(eq(orgs.id, orgId));
  });
}

/**
 * The open-PR demo task gets the agent's change (one new file), so it can be applied to a linked
 * repo (B-3) in the demo and e2e. Idempotent: skipped once the task has a workspace.
 */
async function seedChange(db: ReturnType<typeof createSystemDb>['db'], orgId: string) {
  const [t] = await db.select().from(tasks).where(eq(tasks.title, 'Paginate the audit log endpoint'));
  if (!t || t.orgId !== orgId) return;
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.taskId, t.id));
  if (ws) return;
  const [made] = await db.insert(workspaces).values({ orgId, taskId: t.id, repoId: t.repoId, baseSha: 'f'.repeat(40), baseRef: 'main' }).returning();
  await db.insert(workspaceFiles).values({
    workspaceId: made!.id,
    orgId,
    path: 'src/audit/paginate.ts',
    op: 'create',
    content: 'export function paginate<T>(rows: T[], cursor: number, limit = 50) {\n  return { items: rows.slice(cursor, cursor + limit), next: cursor + limit < rows.length ? cursor + limit : null };\n}\n',
  });
  await db.update(tasks).set({ summaryMd: 'The audit log endpoint returns 50 entries per page with a cursor.' }).where(eq(tasks.id, t.id));
}

await main();
