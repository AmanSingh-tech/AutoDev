import { createAppDb, createSystemDb, eq, schema } from '@autodev/db';
import { makeOrg, testKms, TEST_APP_URL, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ANTHROPIC, apiError, messageStream, modelsOk } from '../test/anthropic-mock';
import { CredentialService, KeyRejected } from './credentials';
import { KeyFailure, LlmBlocked } from './errors';
import { LlmGateway } from './gateway';
import { AnthropicProvider } from './providers/anthropic';
import { staticRegistry } from './registry';

const sys = createSystemDb(TEST_SYSTEM_URL);
const app = createAppDb(TEST_APP_URL);
const server = setupServer();
const providers = staticRegistry([new AnthropicProvider({ baseURL: ANTHROPIC, maxRetries: 0 })]);
const credentials = new CredentialService({ app: app.db, sys: sys.db, kms: testKms, providers });
const gateway = new LlmGateway({ sys: sys.db, providers, credentials });

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await Promise.all([sys.close(), app.close()]);
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let dev: { id: string };
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  const [u] = await sys.db.insert(schema.users).values({ githubUserId: 77, githubLogin: 'dev' }).returning();
  dev = u!;
  await sys.db.insert(schema.orgMembers).values({ orgId: fx.org.id, userId: dev.id, role: 'developer' });
});

/** The Anthropic mock: keys starting with sk-ant-good work; anything else is rejected. */
function anthropic(opts: { usage?: object; model?: string; onRequest?: (body: Record<string, unknown>, key: string | null) => void } = {}) {
  server.use(
    http.get(`${ANTHROPIC}/v1/models`, ({ request }) =>
      request.headers.get('x-api-key')?.startsWith('sk-ant-good')
        ? HttpResponse.json({ data: [], has_more: false })
        : apiError(401, 'authentication_error'),
    ),
    http.post(`${ANTHROPIC}/v1/messages`, async ({ request }) => {
      const key = request.headers.get('x-api-key');
      opts.onRequest?.((await request.json()) as Record<string, unknown>, key);
      if (!key?.startsWith('sk-ant-good')) return apiError(401, 'authentication_error');
      return messageStream({
        model: opts.model,
        content: [{ type: 'text', text: 'done' }],
        usage: opts.usage ?? { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      });
    }),
  );
}

const addKey = (over: Partial<Parameters<CredentialService['create']>[0]> = {}) =>
  credentials.create({
    orgId: fx.org.id,
    actorUserId: fx.owner.id,
    scope: 'org',
    provider: 'anthropic',
    label: 'Company key',
    apiKey: 'sk-ant-good-org-AAAA',
    ...over,
  });

const req = { system: [{ text: 'You are AutoDev.' }], messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }] };
const ctx = (over: object = {}) => ({ orgId: fx.org.id, userId: dev.id, useCase: 'agent' as const, ...over });

describe('CredentialService', () => {
  it('rejects a key the provider refuses and stores nothing', async () => {
    anthropic();
    await expect(addKey({ apiKey: 'sk-ant-bad-1234' })).rejects.toBeInstanceOf(KeyRejected);
    expect(await sys.db.select().from(schema.llmCredentials)).toEqual([]);
  });

  it('stores a valid key encrypted, write-only, and audits it without the secret', async () => {
    anthropic();
    const meta = await addKey();
    expect(meta).toMatchObject({ last4: 'AAAA', status: 'active', scope: 'org' });
    expect(meta).not.toHaveProperty('secretEnc');
    const [row] = await sys.db.select().from(schema.llmCredentials);
    expect(row!.secretEnc.toString('latin1')).not.toContain('sk-ant');
    const [audit] = await sys.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'llm_key.created'));
    expect(JSON.stringify(audit!.metadata)).not.toContain('sk-ant-good');
  });

  it('rotates without a gap: the new key goes live and the old one is superseded', async () => {
    anthropic();
    const first = await addKey();
    const second = await addKey({ apiKey: 'sk-ant-good-org-BBBB' });
    const rows = await sys.db.select().from(schema.llmCredentials);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [first.id]: 'superseded', [second.id]: 'active' });
    expect(rows.find((r) => r.id === second.id)!.rotatedFromId).toBe(first.id);
  });
});

describe('LlmGateway key resolution', () => {
  it('prefers the user key, then the team key, then the org key', async () => {
    anthropic();
    const orgKey = await addKey();
    expect((await gateway.resolveCredential(fx.org.id, dev.id, 'anthropic'))!.id).toBe(orgKey.id);

    const [team] = await sys.db.insert(schema.teams).values({ orgId: fx.org.id, name: 'Platform', slug: 'platform' }).returning();
    await sys.db.insert(schema.teamMembers).values({ teamId: team!.id, userId: dev.id, orgId: fx.org.id });
    const teamKey = await addKey({ scope: 'team', teamId: team!.id, apiKey: 'sk-ant-good-team-TTTT' });
    expect((await gateway.resolveCredential(fx.org.id, dev.id, 'anthropic'))!.id).toBe(teamKey.id);

    const userKey = await addKey({ scope: 'user', userId: dev.id, actorUserId: dev.id, apiKey: 'sk-ant-good-me-UUUU' });
    expect((await gateway.resolveCredential(fx.org.id, dev.id, 'anthropic'))!.id).toBe(userKey.id);

    await sys.db.update(schema.orgs).set({ allowUserKeys: false }).where(eq(schema.orgs.id, fx.org.id));
    expect((await gateway.resolveCredential(fx.org.id, dev.id, 'anthropic'))!.id).toBe(teamKey.id);
  });

  it('uses the primary team when the user is in several teams with keys, else the org key', async () => {
    anthropic();
    const orgKey = await addKey();
    const keys: string[] = [];
    const teamIds: string[] = [];
    for (const name of ['a', 'b']) {
      const [t] = await sys.db.insert(schema.teams).values({ orgId: fx.org.id, name, slug: name }).returning();
      await sys.db.insert(schema.teamMembers).values({ teamId: t!.id, userId: dev.id, orgId: fx.org.id });
      keys.push((await addKey({ scope: 'team', teamId: t!.id, apiKey: `sk-ant-good-${name}-1111` })).id);
      teamIds.push(t!.id);
    }
    expect((await gateway.resolveCredential(fx.org.id, dev.id, 'anthropic'))!.id).toBe(orgKey.id);
    await sys.db.update(schema.orgMembers).set({ primaryTeamId: teamIds[1]! }).where(eq(schema.orgMembers.userId, dev.id));
    expect((await gateway.resolveCredential(fx.org.id, dev.id, 'anthropic'))!.id).toBe(keys[1]);
  });
});

describe('LlmGateway.call', () => {
  it('uses the decrypted key, applies the policy, and meters the call with a frozen cost', async () => {
    let seen: { body?: Record<string, unknown>; key?: string | null } = {};
    anthropic({ onRequest: (body, key) => (seen = { body, key }) });
    await addKey();
    const repoId = fx.repo.id;
    const taskId = uuidv7();

    const res = await gateway.call(ctx({ repoId, taskId }), req);

    expect(seen.key).toBe('sk-ant-good-org-AAAA');
    expect(seen.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 64_000, output_config: { effort: 'high' } });
    // 1000 input × $4/MTok + 500 output × $20/MTok = $0.004 + $0.01
    expect(res.costUsd).toBe('0.014000');
    const [usage] = await sys.db.select().from(schema.tokenUsage);
    expect(usage).toMatchObject({
      orgId: fx.org.id,
      userId: dev.id,
      repoId,
      taskId,
      model: 'claude-opus-5-5',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: '0.014000',
      priced: true,
      credentialScope: 'org',
    });
  });

  it("uses the org's price override when one exists", async () => {
    anthropic();
    await addKey();
    await sys.db.insert(schema.modelPrices).values({
      orgId: fx.org.id,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      inputPerMtok: '1',
      outputPerMtok: '1',
      cacheWrite5mPerMtok: '1',
      cacheWrite1hPerMtok: '1',
      cacheReadPerMtok: '1',
    });
    expect((await gateway.call(ctx(), req)).costUsd).toBe('0.001500');
  });

  it('records unpriced usage as such instead of guessing', async () => {
    anthropic({ model: 'claude-future-9' });
    await addKey();
    await gateway.call(ctx(), req);
    const [usage] = await sys.db.select().from(schema.tokenUsage);
    expect(usage).toMatchObject({ model: 'claude-future-9', priced: false, costUsd: '0.000000' });
  });

  it('blocks when there is no key', async () => {
    const err = await gateway.call(ctx(), req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmBlocked);
    expect(err.reason).toBe('no_credential');
  });

  it('marks a key invalid when it fails mid-run, notifies admins once, and throws KeyFailure', async () => {
    anthropic();
    const key = await addKey();
    // The key stops working on the provider side after it was saved.
    server.use(http.post(`${ANTHROPIC}/v1/messages`, () => apiError(401, 'authentication_error')));

    const err = await gateway.call(ctx(), req).catch((e) => e);
    expect(err).toBeInstanceOf(KeyFailure);
    expect(err.credentialId).toBe(key.id);
    await gateway.call(ctx(), req).catch(() => {});

    const [row] = await sys.db.select().from(schema.llmCredentials).where(eq(schema.llmCredentials.id, key.id));
    expect(row!.status).toBe('invalid');
    const notes = await sys.db.select().from(schema.notifications).where(eq(schema.notifications.type, 'llm_key.invalid'));
    expect(notes.map((n) => n.userId)).toEqual([fx.owner.id]);
  });

  it('enforces the per-task token cap and clamps max_tokens to what is left', async () => {
    let maxTokens = 0;
    anthropic({ onRequest: (b) => (maxTokens = b.max_tokens as number) });
    await addKey();
    const taskId = uuidv7();
    await gateway.call(ctx({ taskId, taskTokenCap: 10_000 }), req); // uses 1500
    expect(maxTokens).toBe(10_000);
    await gateway.call(ctx({ taskId, taskTokenCap: 10_000 }), req);
    expect(maxTokens).toBe(8_500);

    const err = await gateway.call(ctx({ taskId, taskTokenCap: 3_000 }), req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmBlocked);
    expect(err.reason).toBe('task_token_cap');
  });
});

describe('budgets', () => {
  it('warns once at the soft limit and blocks new runs at the hard limit', async () => {
    anthropic();
    await addKey();
    // Each call costs $0.014. A $0.02 org budget is 70% after one call, 140% after two.
    await sys.db.insert(schema.budgets).values({ orgId: fx.org.id, scope: 'org', limitUsd: '0.02', softPct: 50 });

    await gateway.assertRunAllowed(fx.org.id, dev.id);
    await gateway.call(ctx(), req);
    let notes = await sys.db.select().from(schema.notifications);
    expect(notes.map((n) => n.type)).toEqual(['budget.soft_limit']);

    await gateway.call(ctx(), req); // in-flight runs are not stopped by the budget
    notes = await sys.db.select().from(schema.notifications);
    expect(notes.map((n) => n.type).sort()).toEqual(['budget.hard_limit', 'budget.soft_limit']);

    const err = await gateway.assertRunAllowed(fx.org.id, dev.id).catch((e) => e);
    expect(err.reason).toBe('budget_exceeded');
    await gateway.call(ctx(), req);
    expect(await sys.db.select().from(schema.notifications)).toHaveLength(2);
  });

  it("applies a user's own budget only to that user", async () => {
    anthropic();
    await addKey();
    await sys.db.insert(schema.budgets).values({ orgId: fx.org.id, scope: 'user', userId: dev.id, limitUsd: '0.01' });
    await gateway.call(ctx(), req);
    expect((await gateway.assertRunAllowed(fx.org.id, dev.id).catch((e) => e)).reason).toBe('budget_exceeded');
    await expect(gateway.assertRunAllowed(fx.org.id, fx.owner.id)).resolves.toBeUndefined();
  });
});

describe('daily re-validation', () => {
  it('invalidates keys that stopped working and restores ones that work again', async () => {
    anthropic();
    const key = await addKey();
    server.use(http.get(`${ANTHROPIC}/v1/models`, () => apiError(401, 'authentication_error')));
    expect(await credentials.revalidateAll()).toMatchObject({ checked: 1, invalidated: 1 });

    server.use(modelsOk());
    expect(await credentials.revalidateAll()).toMatchObject({ restored: 1 });
    const [row] = await sys.db.select().from(schema.llmCredentials).where(eq(schema.llmCredentials.id, key.id));
    expect(row!.status).toBe('active');
  });

  it('leaves the status alone when the provider is unreachable', async () => {
    anthropic();
    await addKey();
    server.use(http.get(`${ANTHROPIC}/v1/models`, () => apiError(529, 'overloaded_error')));
    expect(await credentials.revalidateAll()).toMatchObject({ invalidated: 0 });
    const [row] = await sys.db.select().from(schema.llmCredentials);
    expect(row!.status).toBe('active');
  });
});
