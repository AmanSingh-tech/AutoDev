/**
 * Seeds the worst-case org: realistic extreme data for stress-testing the UI (long and accented
 * names, unbreakable strings, missing avatars and names, 1,000 tasks, empty and single-item lists,
 * an exceeded budget). Every value is something real data can contain, within the schema's limits.
 *
 * Sign in as `aleksandra-wisniewska-kowalczyk` on the mock GitHub (tools/mock-github, same fake
 * ids) to see it. The demo users aren't members, so their sign-in still lands in acme-demo.
 *
 *   pnpm db:seed:worst            create it (skips if it exists)
 *   pnpm db:seed:worst --remove   delete it again
 */
import { cryptoEnv, dbEnv, loadEnv } from '@autodev/config';
import { createKeyWrapper } from '@autodev/crypto';
import { config } from 'dotenv';
import { eq, inArray } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from 'uuidv7';
import { createSystemDb } from './client';
import { insertOrgWithOwner } from './ops/orgs';
import {
  budgets,
  channelMessages,
  installations,
  notifications,
  orgMembers,
  orgs,
  repoAgentMemory,
  repoChannels,
  repos,
  tasks,
  teamMembers,
  teams,
  tokenUsage,
  userRepoAccess,
  users,
  type Citation,
} from './schema';
import { TASK_STATUSES, type OrgRole, type TaskPriority } from './schema/enums';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
const env = loadEnv(dbEnv.merge(cryptoEnv));

const ORG_LOGIN = 'northwind-industries-holdings-europe';
const LONG_REPO = 'customer-facing-billing-and-subscription-management-service-legacy-v2-migration';

/** GitHub logins are at most 39 characters of [a-z0-9-]; display names are free text. */
const PEOPLE: { id: number; login: string; name: string | null; email: string | null; avatar: boolean; role: OrgRole }[] = [
  { id: 900_011, login: 'aleksandra-wisniewska-kowalczyk', name: 'Aleksandra Wiśniewska-Kowalczyk', email: 'aleksandra.wisniewska-kowalczyk@northwind-industries-holdings.example.com', avatar: false, role: 'owner' },
  { id: 900_012, login: 'jo', name: 'Jo', email: null, avatar: false, role: 'developer' },
  { id: 900_013, login: 'bartholomew-fitzgerald-northwind-hldgs', name: 'Bartholomew Montgomery Fitzgerald III', email: 'bartholomew.fitzgerald@northwind-industries-holdings.example.com', avatar: true, role: 'developer' },
  { id: 900_014, login: 'nguyen-thi-thuy-duong', name: 'Nguyễn Thị Thùy Dương', email: null, avatar: false, role: 'admin' },
  { id: 900_015, login: 'x', name: null, email: null, avatar: false, role: 'viewer' },
  { id: 900_016, login: 'lixiaolong', name: '李小龙', email: null, avatar: false, role: 'developer' },
  { id: 900_017, login: 'unicorn-release-bot', name: '🦄 Release Bot', email: null, avatar: false, role: 'developer' },
];

/** Realistic task titles, up to the 200-character limit, spread across the first rows of each column. */
const TITLES = [
  // Exactly 200 characters, the column's limit (tasks_title_length).
  'Reconcile outstanding enterprise invoices when a customer downgrades mid-cycle and their prorated credit exceeds the next invoice, including multi-currency accounts billed in EUR, GBP and PLN with VAT reverse charge'.slice(0, 200),
  'Fix NullPointerException in NorthwindSubscriptionReconciliationServiceFactoryBeanImpl.reconcileOutstandingInvoicesForEnterpriseCustomers()',
  '🚀 Ship the new onboarding flow 🎉',
  'Fix',
  'Sửa lỗi hiển thị tiếng Việt trong hóa đơn PDF (dấu bị cắt ở dòng đầu tiên)',
  'تحديث صفحة الفواتير لدعم اللغة العربية',
  'Investigate https://northwind-industries-holdings.example.com/billing/subscriptions/enterprise/reconciliation?customer=cus_8f3a9b2c7d1e&period=2026-09',
  'Add retry with exponential backoff to the webhook dispatcher',
  '修复订阅续订时的时区问题',
  'Bump @northwind/billing-sdk from 14.2.0 to 14.2.1',
];
const PRIORITIES: TaskPriority[] = ['urgent', 'high', 'medium', 'low'];

async function main() {
  const { db, close } = createSystemDb(env.DATABASE_URL_SYSTEM);
  try {
    const [existing] = await db.select().from(orgs).where(eq(orgs.githubLogin, ORG_LOGIN));
    if (process.argv.includes('--remove')) {
      if (existing) await db.delete(orgs).where(eq(orgs.id, existing.id));
      await db.delete(users).where(inArray(users.githubUserId, PEOPLE.map((p) => p.id)));
      console.log(existing ? 'removed the worst-case org' : 'no worst-case org to remove');
      return;
    }
    if (existing) {
      console.log('worst-case org already seeded');
      return;
    }

    // One transaction: a failure leaves nothing half-seeded.
    await db.transaction(async (db) => {
      const people = await db
        .insert(users)
        .values(
          PEOPLE.map((p) => ({
            githubUserId: p.id,
            githubLogin: p.login,
            name: p.name,
            email: p.email,
            avatarUrl: p.avatar ? `https://avatars.githubusercontent.com/u/${p.id}` : null,
          })),
        )
        .onConflictDoNothing()
        .returning();
      const all = people.length ? people : await db.select().from(users).where(inArray(users.githubUserId, PEOPLE.map((p) => p.id)));
      const byLogin = new Map(all.map((u) => [u.githubLogin, u]));
      const owner = byLogin.get(PEOPLE[0]!.login)!;

      const org = await insertOrgWithOwner(db, createKeyWrapper(env), {
        githubAccountId: 900_110,
        githubLogin: ORG_LOGIN,
        accountType: 'Organization',
        name: 'Northwind Industries Holdings — Platform Engineering (Europe, Middle East & Africa)',
        ownerUserId: owner.id,
      });
      await db.update(orgs).set({ taskKeyPrefix: 'NORTHWIND' }).where(eq(orgs.id, org.id));
      await db.insert(orgMembers).values(PEOPLE.slice(1).map((p) => ({ orgId: org.id, userId: byLogin.get(p.login)!.id, role: p.role })));

      const [inst] = await db
        .insert(installations)
        .values({
          orgId: org.id,
          githubInstallationId: 900_210,
          accountLogin: ORG_LOGIN,
          accountType: 'Organization',
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read', members: 'read' },
          installedByUserId: owner.id,
        })
        .returning();
      const repoRows = await db
        .insert(repos)
        .values(
          [LONG_REPO, 'ui', 'handbook'].map((name, i) => ({
            orgId: org.id,
            installationId: inst!.id,
            githubRepoId: 900_310 + i,
            owner: ORG_LOGIN,
            name,
            fullName: `${ORG_LOGIN}/${name}`,
            defaultBranch: 'main',
            private: true,
            lastSyncedAt: new Date(),
          })),
        )
        .returning();
      const [longRepo, uiRepo] = repoRows as [(typeof repoRows)[0], (typeof repoRows)[0]];
      const far = new Date('2999-01-01');
      await db.insert(userRepoAccess).values(
        all.flatMap((u) =>
          repoRows.map((r) => ({ userId: u.id, repoId: r.id, orgId: org.id, permission: u.id === owner.id ? ('admin' as const) : ('push' as const), fetchedAt: new Date(), expiresAt: far })),
        ),
      );

      // Teams: one with a single member (counts of exactly 1), one with a long name.
      const [solo, platform] = await db
        .insert(teams)
        .values([
          { orgId: org.id, name: 'Solo', slug: 'solo' },
          { orgId: org.id, name: 'Platform Reliability, Observability & Developer Experience (EMEA)', slug: 'platform-reliability-observability-developer-experience-emea' },
        ])
        .returning();
      await db.insert(teamMembers).values([
        { orgId: org.id, teamId: solo!.id, userId: byLogin.get('jo')!.id },
        ...all.map((u) => ({ orgId: org.id, teamId: platform!.id, userId: u.id })),
      ]);

      // 1,000 tasks on the long repo, every status and priority, the extreme titles first; one on `ui`.
      const rows: (typeof tasks.$inferInsert)[] = [];
      for (let n = 1; n <= 1000; n++) {
        const title = n <= TITLES.length ? TITLES[n - 1]! : `${TITLES[n % TITLES.length]!.slice(0, 120)} (#${n})`;
        const who = all[n % all.length]!;
        const status = TASK_STATUSES[n % TASK_STATUSES.length]!;
        rows.push({
          orgId: org.id,
          repoId: longRepo.id,
          number: n,
          key: `NORTHWIND-${n}`,
          title,
          descriptionMd: n === 1 ? `${'Customers on annual plans who downgrade mid-cycle get a credit. '.repeat(40)}` : 'See title.',
          acceptanceCriteriaMd: '- Behaves as described',
          priority: PRIORITIES[n % PRIORITIES.length]!,
          status,
          mode: 'plan_lld',
          branchMode: 'new',
          workBranch: `autodev/NORTHWIND-${n}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'task'}`,
          ownerId: who.id,
          createdBy: who.id,
          promptScore: n % 7 === 0 ? null : (n * 37) % 101,
          promptScoreDetails: n % 7 === 0 ? null : { version: 1, flags: n % 3 === 0 ? ['missing_repro', 'missing_acceptance_criteria', 'missing_file_hints', 'vague_scope', 'unfilled_todo'] : [] },
          completedAt: status === 'resolved' ? new Date() : null,
        });
      }
      rows.push({
        orgId: org.id,
        repoId: uiRepo.id,
        number: 1001,
        key: 'NORTHWIND-1001',
        title: 'Jo',
        priority: 'low',
        status: 'draft',
        mode: 'direct',
        branchMode: 'new',
        workBranch: 'autodev/NORTHWIND-1001-jo',
        ownerId: byLogin.get('jo')!.id,
        createdBy: byLogin.get('jo')!.id,
      });
      for (let i = 0; i < rows.length; i += 200) await db.insert(tasks).values(rows.slice(i, i + 200));
      await db.update(orgs).set({ taskSeq: 1001 }).where(eq(orgs.id, org.id));

      // The team room: long and unbreakable messages, a cited agent answer and a failed one.
      const [room] = await db.insert(repoChannels).values({ orgId: org.id, repoId: longRepo.id }).returning();
      const base = { orgId: org.id, channelId: room!.id, repoId: longRepo.id };
      const longPath = 'services/billing/src/main/kotlin/com/northwind/billing/reconciliation/enterprise/NorthwindSubscriptionReconciliationServiceFactoryBeanImpl.kt';
      const citations: Citation[] = Array.from({ length: 20 }, (_, i) => ({ path: i === 0 ? longPath : `src/module-${i}/index.ts`, startLine: 10 * i + 1, endLine: 10 * i + 40 }));
      const t0 = Date.now() - 3_600_000;
      const msgs: (typeof channelMessages.$inferInsert)[] = [
        { ...base, author: 'user', userId: byLogin.get('jo')!.id, content: 'k' },
        { ...base, author: 'user', userId: byLogin.get('bartholomew-fitzgerald-northwind-hldgs')!.id, content: `Logs: https://northwind-industries-holdings.example.com/observability/grafana/d/billing-reconciliation-enterprise/billing?orgId=1&from=now-24h&to=now&var-customer=cus_8f3a9b2c7d1e4f5a6b7c8d9e` },
        { ...base, author: 'user', userId: owner.id, content: `${'Before the release we need to check the reconciliation path for multi-currency accounts again. '.repeat(40)}`.slice(0, 4000) },
        { ...base, author: 'user', userId: byLogin.get('lixiaolong')!.id, content: '@agent 订阅续订的时区逻辑在哪里？' },
        { ...base, author: 'agent', userId: byLogin.get('lixiaolong')!.id, content: `It's in \`${longPath}:12-40\`, plus helpers across ${citations.length - 1} modules.`, citations, commitSha: 'f'.repeat(40) },
        { ...base, author: 'user', userId: byLogin.get('unicorn-release-bot')!.id, content: '🦄🦄🦄 Release 14.2.1 is out 🎉' },
        { ...base, author: 'agent', userId: owner.id, status: 'failed', content: "I couldn't answer this. The monthly AI budget is used up." },
      ];
      await db.insert(channelMessages).values(msgs.map((m, i) => ({ ...m, createdAt: new Date(t0 + i * 60_000) })));

      await db.insert(repoAgentMemory).values([
        { orgId: org.id, repoId: longRepo.id, section: 'rules', contentMd: Array.from({ length: 30 }, (_, i) => `- Rule ${i + 1}: never call \`${longPath}\` directly from a controller.`).join('\n').slice(0, 8000), updatedBy: byLogin.get('nguyen-thi-thuy-duong')!.id },
        { orgId: org.id, repoId: longRepo.id, section: 'fragile_areas', contentMd: 'x', updatedBy: byLogin.get('x')!.id },
      ]);

      // Usage: large numbers, and a budget that's over its limit.
      const usage: (typeof tokenUsage.$inferInsert)[] = [];
      const now = new Date();
      for (let day = 1; day <= now.getUTCDate(); day++) {
        for (const u of all) {
          usage.push({
            id: uuidv7(),
            createdAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, 10)),
            orgId: org.id,
            userId: u.id,
            repoId: longRepo.id,
            provider: 'anthropic',
            model: 'claude-opus-5-5',
            useCase: 'agent',
            inputTokens: 2_400_000,
            outputTokens: 180_000,
            cacheReadTokens: 9_800_000,
            costUsd: '16.960000',
          });
        }
      }
      await db.insert(tokenUsage).values(usage);
      await db.insert(budgets).values({ orgId: org.id, scope: 'org', limitUsd: '1.00', softPct: 80 });

      await db.insert(notifications).values(
        Array.from({ length: 25 }, (_, i) => ({
          orgId: org.id,
          userId: owner.id,
          type: 'task.needs_input',
          title: i === 0 ? TITLES[0]! : `NORTHWIND-${i + 1} needs your input`,
          body: i === 0 ? TITLES[1]! : null,
          link: `/o/${ORG_LOGIN}/tasks/NORTHWIND-${i + 1}`,
        })),
      );
    });
    console.log(`seeded the worst-case org ${ORG_LOGIN}`);
  } finally {
    await close();
  }
}

await main();
