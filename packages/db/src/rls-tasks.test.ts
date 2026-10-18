import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, truncateAll } from '../test/fixtures';
import { TEST_APP_URL, TEST_SYSTEM_URL } from '../test/env';
import { createAppDb, createSystemDb, withOrg } from './client';
import { taskEvents, tasks } from './schema';

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

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { cause?: { message?: string }; message: string };
    return err.cause?.message ?? err.message;
  }
  throw new Error('expected the query to fail');
}

const task = (fx: typeof a, n: number, over: Partial<typeof tasks.$inferInsert> = {}) => ({
  orgId: fx.org.id,
  repoId: fx.repo.id,
  number: n,
  key: `AD-${n}`,
  title: 'Fix login',
  mode: 'plan_lld' as const,
  branchMode: 'new' as const,
  workBranch: `autodev/AD-${n}-fix-login`,
  ownerId: fx.owner.id,
  ...over,
});

describe('tasks', () => {
  it('isolates tasks per org and keeps keys unique per org only', async () => {
    await sys.db.insert(tasks).values([task(a, 1), task(b, 1)]);
    const rows = await withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.select().from(tasks));
    expect(rows.map((r) => r.orgId)).toEqual([a.org.id]);
    expect(await pgError(sys.db.insert(tasks).values(task(a, 1)))).toMatch(/tasks_org_number_uq|tasks_org_key_uq/);
  });

  it('rejects a related task from another org', async () => {
    const [other] = await sys.db.insert(tasks).values(task(b, 1)).returning();
    expect(await pgError(sys.db.insert(tasks).values(task(a, 2, { relatedTaskId: other!.id })))).toMatch(/same org/);
  });

  it('enforces branch and scope rules in the database too', async () => {
    expect(await pgError(sys.db.insert(tasks).values(task(a, 3, { branchMode: 'existing' })))).toMatch(/tasks_existing_needs_target/);
    expect(await pgError(sys.db.insert(tasks).values(task(a, 4, { scopePath: '../etc' })))).toMatch(/tasks_scope_path_relative/);
    expect(await pgError(sys.db.insert(tasks).values(task(a, 5, { scopePath: '/abs' })))).toMatch(/tasks_scope_path_relative/);
  });

  it('cannot be deleted by the app role, and events are append-only', async () => {
    const [t] = await sys.db.insert(tasks).values(task(a, 1)).returning();
    expect(await pgError(withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.delete(tasks)))).toMatch(/permission denied/);
    await withOrg(app.db, a.org.id, a.owner.id, (tx) =>
      tx.insert(taskEvents).values({ orgId: a.org.id, taskId: t!.id, actorType: 'user', type: 'created' }),
    );
    expect(await pgError(sys.db.update(taskEvents).set({ type: 'x' }).where(eq(taskEvents.taskId, t!.id)))).toMatch(/append-only/);
  });
});
