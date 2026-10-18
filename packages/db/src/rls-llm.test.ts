import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, truncateAll } from '../test/fixtures';
import { TEST_APP_URL, TEST_SYSTEM_URL } from '../test/env';
import { createAppDb, createSystemDb, withOrg } from './client';
import { llmCredentials, modelPrices, tokenUsage } from './schema';

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

const credential = (orgId: string) => ({
  orgId,
  scope: 'org' as const,
  provider: 'anthropic' as const,
  label: 'Company key',
  secretEnc: Buffer.from('ciphertext'),
  dataKeyVersion: 1,
  last4: 'WXYZ',
});

describe('llm_credentials', () => {
  it('lets the app role write a key and read its metadata, but never the ciphertext', async () => {
    await withOrg(app.db, a.org.id, a.owner.id, (tx) =>
      tx.insert(llmCredentials).values(credential(a.org.id)).returning({ id: llmCredentials.id }),
    );
    const meta = await withOrg(app.db, a.org.id, a.owner.id, (tx) =>
      tx.select({ last4: llmCredentials.last4, status: llmCredentials.status }).from(llmCredentials),
    );
    expect(meta).toEqual([{ last4: 'WXYZ', status: 'active' }]);
    expect(await pgError(withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.select().from(llmCredentials)))).toMatch(
      /permission denied/,
    );
  });

  it('allows only one active key per scope target', async () => {
    await sys.db.insert(llmCredentials).values(credential(a.org.id));
    expect(await pgError(sys.db.insert(llmCredentials).values(credential(a.org.id)))).toMatch(/llm_credentials_one_active/);
    await sys.db.insert(llmCredentials).values({ ...credential(a.org.id), status: 'superseded' });
  });

  it("isolates other orgs' keys", async () => {
    await sys.db.insert(llmCredentials).values(credential(b.org.id));
    const rows = await withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.select({ id: llmCredentials.id }).from(llmCredentials));
    expect(rows).toEqual([]);
  });
});

describe('token_usage (partitioned)', () => {
  const usage = (orgId: string) => ({
    id: uuidv7(),
    orgId,
    provider: 'anthropic' as const,
    model: 'claude-opus-5-5',
    useCase: 'agent' as const,
    inputTokens: 100,
    costUsd: '0.000400',
  });

  it('is written by the system role and read per org through the parent', async () => {
    await sys.db.insert(tokenUsage).values([usage(a.org.id), usage(b.org.id)]);
    const rows = await withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.select().from(tokenUsage));
    expect(rows.map((r) => r.orgId)).toEqual([a.org.id]);
  });

  it('rejects inserts from the app role and direct partition access', async () => {
    expect(await pgError(withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.insert(tokenUsage).values(usage(a.org.id))))).toMatch(
      /permission denied/,
    );
    const [{ part }] = (await sys.db.execute(
      sql`select format('token_usage_y%sm%s', to_char(now(), 'YYYY'), to_char(now(), 'MM')) as part`,
    )) as unknown as [{ part: string }];
    expect(await pgError(withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.execute(sql.raw(`select * from ${part}`))))).toMatch(
      /permission denied/,
    );
  });

  it('creates future partitions idempotently', async () => {
    await sys.db.execute(sql`select ensure_token_usage_partitions(4)`);
    await sys.db.execute(sql`select ensure_token_usage_partitions(4)`);
    const rows = (await sys.db.execute(
      sql`select count(*)::int as n from pg_inherits where inhparent = 'token_usage'::regclass`,
    )) as unknown as [{ n: number }];
    expect(rows[0].n).toBeGreaterThanOrEqual(6); // 5 months + default
  });
});

describe('model_prices', () => {
  it("shows global prices plus the org's own overrides, never another org's", async () => {
    const override = (orgId: string) => ({
      orgId,
      provider: 'anthropic' as const,
      model: 'claude-opus-5-5',
      inputPerMtok: '3.5',
      outputPerMtok: '18',
      cacheWrite5mPerMtok: '4.375',
      cacheWrite1hPerMtok: '7',
      cacheReadPerMtok: '0.2',
    });
    await withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.insert(modelPrices).values(override(a.org.id)));
    await sys.db.insert(modelPrices).values(override(b.org.id));

    const rows = await withOrg(app.db, a.org.id, a.owner.id, (tx) =>
      tx.select().from(modelPrices).where(sql`${modelPrices.model} = 'claude-opus-5-5'`),
    );
    expect(rows.map((r) => r.orgId ?? 'global').sort()).toEqual([a.org.id, 'global'].sort());
  });

  it('does not let an org edit the global defaults', async () => {
    const updated = await withOrg(app.db, a.org.id, a.owner.id, (tx) =>
      tx.update(modelPrices).set({ inputPerMtok: '0' }).where(sql`${modelPrices.orgId} is null`).returning({ id: modelPrices.id }),
    );
    expect(updated).toEqual([]);
  });
});
