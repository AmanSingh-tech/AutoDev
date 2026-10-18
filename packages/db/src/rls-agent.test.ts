import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, truncateAll } from '../test/fixtures';
import { TEST_APP_URL, TEST_SYSTEM_URL } from '../test/env';
import { createAppDb, createSystemDb, withOrg } from './client';
import { agentRuns, blobs, taskDocuments, tasks } from './schema';

const sys = createSystemDb(TEST_SYSTEM_URL);
const app = createAppDb(TEST_APP_URL);
afterAll(async () => {
  await Promise.all([sys.close(), app.close()]);
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let taskId: string;
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  const [t] = await sys.db
    .insert(tasks)
    .values({ orgId: fx.org.id, repoId: fx.repo.id, number: 1, key: 'AD-1', title: 'x', mode: 'plan_lld', branchMode: 'new', workBranch: 'autodev/AD-1', ownerId: fx.owner.id })
    .returning();
  taskId = t!.id;
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

describe('agent runtime tables', () => {
  it('lets only the system role write runs, and nobody but it touch blobs', async () => {
    expect(await pgError(withOrg(app.db, fx.org.id, fx.owner.id, (tx) => tx.insert(agentRuns).values({ orgId: fx.org.id, taskId, phase: 'plan' })))).toMatch(/permission denied/);
    await sys.db.insert(agentRuns).values({ orgId: fx.org.id, taskId, phase: 'plan' });
    expect(await withOrg(app.db, fx.org.id, fx.owner.id, (tx) => tx.select().from(agentRuns))).toHaveLength(1);
    expect(await pgError(withOrg(app.db, fx.org.id, fx.owner.id, (tx) => tx.select().from(blobs)))).toMatch(/permission denied/);
  });

  it('keeps document content immutable while reviews update', async () => {
    const [doc] = await sys.db.insert(taskDocuments).values({ orgId: fx.org.id, taskId, kind: 'plan', version: 1, contentMd: '# Plan' }).returning();
    await withOrg(app.db, fx.org.id, fx.owner.id, (tx) => tx.update(taskDocuments).set({ status: 'approved', reviewerId: fx.owner.id }).where(eq(taskDocuments.id, doc!.id)));
    expect(await pgError(sys.db.update(taskDocuments).set({ contentMd: 'rewritten' }).where(eq(taskDocuments.id, doc!.id)))).toMatch(/immutable/);
  });

  it('allows only one pending document per kind', async () => {
    await sys.db.insert(taskDocuments).values({ orgId: fx.org.id, taskId, kind: 'plan', version: 1, contentMd: 'a' });
    expect(await pgError(sys.db.insert(taskDocuments).values({ orgId: fx.org.id, taskId, kind: 'plan', version: 2, contentMd: 'b' }))).toMatch(/task_documents_one_pending/);
  });
});
