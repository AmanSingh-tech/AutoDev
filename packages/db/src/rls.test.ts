import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, truncateAll } from '../test/fixtures';
import { TEST_APP_URL, TEST_SYSTEM_URL } from '../test/env';
import { createAppDb, createSystemDb, withOrg, withUser } from './client';
import { auditLog, githubTokens, orgMembers, orgs, repos, users } from './schema';

const sys = createSystemDb(TEST_SYSTEM_URL);
const app = createAppDb(TEST_APP_URL);

afterAll(async () => {
  await Promise.all([sys.close(), app.close()]);
});

let a: Awaited<ReturnType<typeof makeOrg>>;
let b: Awaited<ReturnType<typeof makeOrg>>;

beforeEach(async () => {
  await truncateAll(sys.db);
  a = await makeOrg(sys.db, 'acme');
  b = await makeOrg(sys.db, 'globex');
});

/** Unwraps the Postgres error that drizzle wraps. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { cause?: { message?: string }; message: string };
    return err.cause?.message ?? err.message;
  }
  throw new Error('expected the query to fail');
}

describe('row-level security', () => {
  it('scopes tenant tables to the current org', async () => {
    const rows = await withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.select().from(repos));
    expect(rows.map((r) => r.fullName)).toEqual(['acme/web']);
  });

  it('returns nothing when no org context is set (fails closed)', async () => {
    expect(await app.db.select().from(repos)).toEqual([]);
    expect(await app.db.select().from(orgs)).toEqual([]);
  });

  it("rejects writing a row into another org's tenant", async () => {
    const msg = await pgError(
      withOrg(app.db, a.org.id, a.owner.id, (tx) =>
        tx.insert(repos).values({
          orgId: b.org.id,
          installationId: b.installation.id,
          githubRepoId: 999_999,
          owner: 'globex',
          name: 'x',
          fullName: 'globex/x',
          defaultBranch: 'main',
          private: true,
        }),
      ),
    );
    expect(msg).toMatch(/row-level security/);
  });

  it("cannot update another org's rows even by id", async () => {
    const updated = await withOrg(app.db, a.org.id, a.owner.id, (tx) =>
      tx.update(repos).set({ archived: true }).where(sql`${repos.id} = ${b.repo.id}`).returning(),
    );
    expect(updated).toEqual([]);
  });

  it('lets a user list their own memberships across orgs, and only those', async () => {
    await sys.db.insert(orgMembers).values({ orgId: b.org.id, userId: a.owner.id, role: 'viewer' });
    const visible = await withUser(app.db, a.owner.id, (tx) => tx.select().from(orgs));
    expect(visible.map((o) => o.githubLogin).sort()).toEqual(['acme', 'globex']);

    const bOnly = await withUser(app.db, b.owner.id, (tx) => tx.select().from(orgs));
    expect(bOnly.map((o) => o.githubLogin)).toEqual(['globex']);
  });

  it('hides users who are not in the current org', async () => {
    const visible = await withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.select().from(users));
    expect(visible.map((u) => u.id)).toEqual([a.owner.id]);
  });

  it('denies the app role any access to github_tokens', async () => {
    const msg = await pgError(
      withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.select().from(githubTokens)),
    );
    expect(msg).toMatch(/permission denied/);
  });

  it('keeps audit_log append-only, even for the system role', async () => {
    await withOrg(app.db, a.org.id, a.owner.id, (tx) =>
      tx.insert(auditLog).values({ orgId: a.org.id, actorType: 'user', action: 'test.event' }),
    );
    expect(
      await pgError(
        withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.delete(auditLog)),
      ),
    ).toMatch(/permission denied/);
    expect(await pgError(sys.db.update(auditLog).set({ action: 'tampered' }))).toMatch(
      /append-only/,
    );
  });

  it("cannot append audit events to another org's log", async () => {
    const msg = await pgError(
      withOrg(app.db, a.org.id, a.owner.id, (tx) =>
        tx.insert(auditLog).values({ orgId: b.org.id, actorType: 'user', action: 'x' }),
      ),
    );
    expect(msg).toMatch(/row-level security/);
  });
});
