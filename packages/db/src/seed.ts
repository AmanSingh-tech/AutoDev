/**
 * Seeds a demo org so the UI has data without a real GitHub App. Idempotent.
 * The GitHub IDs are fake (900000+) and won't collide with real accounts in dev.
 */
import { loadEnv, cryptoEnv, dbEnv } from '@autodev/config';
import { createKeyWrapper } from '@autodev/crypto';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { createSystemDb } from './client';
import { insertOrgWithOwner } from './ops/orgs';
import { uuidv7 } from 'uuidv7';
import { budgets, installations, orgMembers, orgs, repos, tokenUsage, userRepoAccess, users } from './schema';
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
    console.log('seeded demo org acme-demo');
  } finally {
    await close();
  }
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

await main();
