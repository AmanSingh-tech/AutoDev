import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, truncateAll } from '../test/fixtures';
import { TEST_APP_URL, TEST_SYSTEM_URL } from '../test/env';
import { createAppDb, createSystemDb, withOrg } from './client';
import { promptTemplates } from './schema';

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
  await sys.db.insert(promptTemplates).values([
    { orgId: a.org.id, name: 'Acme bug', kind: 'bug_fix' },
    { orgId: b.org.id, name: 'Globex bug', kind: 'bug_fix' },
  ]);
});

describe('prompt templates RLS', () => {
  it('shows an org only its own templates', async () => {
    const rows = await withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.select().from(promptTemplates));
    expect(rows.map((r) => r.name)).toEqual(['Acme bug']);
  });

  it('will not write a template into another org', async () => {
    await expect(
      withOrg(app.db, a.org.id, a.owner.id, (tx) =>
        tx.insert(promptTemplates).values({ orgId: b.org.id, name: 'sneaky', kind: 'feature' }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('only accepts the five template kinds', async () => {
    await expect(
      withOrg(app.db, a.org.id, a.owner.id, (tx) =>
        tx.insert(promptTemplates).values({ orgId: a.org.id, name: 'odd', kind: 'poem' }),
      ),
    ).rejects.toThrow(/prompt_templates_kind/);
  });
});
