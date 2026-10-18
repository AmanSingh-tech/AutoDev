import { eq, schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, ANTHROPIC, callerFor, createTestDeps, msw } from '../../test/harness';

const h = createTestDeps();
const { deps } = h;
beforeAll(() => msw.listen({ onUnhandledRequest: 'error' }));
afterAll(async () => {
  msw.close();
  await h.close();
});

/** Keys starting with sk-ant-good validate; anything else is rejected. */
function anthropic() {
  msw.use(
    http.get(`${ANTHROPIC}/v1/models`, ({ request }) =>
      request.headers.get('x-api-key')?.startsWith('sk-ant-good')
        ? HttpResponse.json({ data: [], has_more: false })
        : HttpResponse.json({ type: 'error', error: { type: 'authentication_error', message: 'x' } }, { status: 401 }),
    ),
  );
}
afterEach(() => msw.resetHandlers());

let fx: Awaited<ReturnType<typeof makeOrg>>;
let admin: { id: string };
let dev: { id: string };
let viewer: { id: string };
beforeEach(async () => {
  await truncateAll(deps.sys);
  fx = await makeOrg(deps.sys, 'acme');
  admin = await addMember(deps, fx.org.id, 'admin', 'admin');
  dev = await addMember(deps, fx.org.id, 'dev', 'developer');
  viewer = await addMember(deps, fx.org.id, 'viewer', 'viewer');
  anthropic();
});

const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);
const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const KEY = 'sk-ant-good-0123456789-WXYZ';

describe('llmKeys', () => {
  it('lets admins add org keys and never returns the secret', async () => {
    const meta = await as(admin).llmKeys.create({ scope: 'org', provider: 'anthropic', label: 'Company', apiKey: KEY });
    expect(meta.last4).toBe('WXYZ');
    expect(JSON.stringify(meta)).not.toContain('sk-ant');
    const list = await as(admin).llmKeys.list();
    expect(JSON.stringify(list)).not.toContain('sk-ant');
    expect(list).toHaveLength(1);
  });

  it('turns a rejected key into a clear BAD_REQUEST', async () => {
    const err = await as(admin).llmKeys.create({ scope: 'org', provider: 'anthropic', label: 'x', apiKey: 'sk-ant-bad-0123456789' }).catch((e) => e);
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toMatch(/rejected this key/);
  });

  it('restricts org/team keys to admins and personal keys to non-viewers', async () => {
    expect(await code(as(dev).llmKeys.create({ scope: 'org', provider: 'anthropic', label: 'x', apiKey: KEY }))).toBe('FORBIDDEN');
    expect(await code(as(viewer).llmKeys.create({ scope: 'user', provider: 'anthropic', label: 'x', apiKey: KEY }))).toBe('FORBIDDEN');
    expect(await code(as(dev).llmKeys.create({ scope: 'user', provider: 'anthropic', label: 'mine', apiKey: KEY }))).toBe('OK');

    await as(admin).orgs.updateSettings({ allowUserKeys: false });
    expect(await code(as(dev).llmKeys.create({ scope: 'user', provider: 'anthropic', label: 'x', apiKey: KEY }))).toBe('FORBIDDEN');
  });

  it("shows developers only their own keys and lets them revoke only those", async () => {
    const orgKey = await as(admin).llmKeys.create({ scope: 'org', provider: 'anthropic', label: 'Company', apiKey: KEY });
    const mine = await as(dev).llmKeys.create({ scope: 'user', provider: 'anthropic', label: 'mine', apiKey: KEY });
    expect((await as(dev).llmKeys.list()).map((k) => k.id)).toEqual([mine.id]);
    expect(await as(dev).llmKeys.effective()).toEqual({ scope: 'user', last4: 'WXYZ' });
    expect(await code(as(dev).llmKeys.revoke({ id: orgKey.id }))).toBe('FORBIDDEN');
    expect(await code(as(dev).llmKeys.revoke({ id: mine.id }))).toBe('OK');
    expect(await as(dev).llmKeys.effective()).toEqual({ scope: 'org', last4: 'WXYZ' });
  });

  it('rejects a team from another org', async () => {
    const other = await makeOrg(deps.sys, 'globex');
    const [team] = await deps.sys.insert(schema.teams).values({ orgId: other.org.id, name: 't', slug: 't' }).returning();
    expect(await code(as(admin).llmKeys.create({ scope: 'team', teamId: team!.id, provider: 'anthropic', label: 'x', apiKey: KEY }))).toBe('NOT_FOUND');
  });
});

describe('models', () => {
  it('returns the default policy until one is saved, and requires a priced model', async () => {
    expect((await as(dev).models.policies())[0]).toMatchObject({ useCase: 'agent', model: 'claude-opus-5-5', isDefault: true });
    expect(await code(as(dev).models.setPolicy({ useCase: 'agent', model: 'claude-sonnet-5-5', maxTokensPerTask: 1_000_000, maxOutputTokens: 32_000, effort: 'medium' }))).toBe('FORBIDDEN');
    expect(await code(as(admin).models.setPolicy({ useCase: 'agent', model: 'gpt-9', maxTokensPerTask: 1_000_000, maxOutputTokens: 32_000, effort: null }))).toBe('BAD_REQUEST');
    await as(admin).models.setPolicy({ useCase: 'agent', model: 'claude-sonnet-5-5', maxTokensPerTask: 1_000_000, maxOutputTokens: 32_000, effort: 'medium' });
    expect((await as(dev).models.policies())[0]).toMatchObject({ model: 'claude-sonnet-5-5', isDefault: false });
  });

  it('overrides a price for the org only, effective-dated', async () => {
    await as(admin).models.setPrice({ model: 'claude-opus-5-5', inputPerMtok: '3.5', outputPerMtok: '18', cacheWrite5mPerMtok: '4.375', cacheWrite1hPerMtok: '7', cacheReadPerMtok: '0.18' });
    await as(admin).models.setPrice({ model: 'claude-opus-5-5', inputPerMtok: '3', outputPerMtok: '18', cacheWrite5mPerMtok: '4.375', cacheWrite1hPerMtok: '7', cacheReadPerMtok: '0.18' });
    const opus = (await as(dev).models.prices()).find((p) => p.model === 'claude-opus-5-5')!;
    expect(opus).toMatchObject({ overridden: true, inputPerMtok: '3.000000' });
    expect(opus.global!.inputPerMtok).toBe('4.000000');
    const history = await deps.sys.select().from(schema.modelPrices).where(eq(schema.modelPrices.orgId, fx.org.id));
    expect(history.filter((r) => r.effectiveTo === null)).toHaveLength(1);
    expect(history).toHaveLength(2);

    await as(admin).models.clearPriceOverride({ model: 'claude-opus-5-5' });
    expect((await as(dev).models.prices()).find((p) => p.model === 'claude-opus-5-5')!.overridden).toBe(false);
  });
});

describe('budgets and usage', () => {
  async function usage(userId: string, cost: string) {
    await deps.sys.insert(schema.tokenUsage).values({
      id: uuidv7(),
      orgId: fx.org.id,
      userId,
      repoId: fx.repo.id,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      useCase: 'agent',
      inputTokens: 1000,
      outputTokens: 100,
      costUsd: cost,
    });
  }

  it('reports spend against budgets and blocks the user at a hard limit', async () => {
    await as(admin).budgets.set({ scope: 'org', limitUsd: 100 });
    await as(admin).budgets.set({ scope: 'user', userId: dev.id, limitUsd: 1 });
    await usage(dev.id, '1.500000');
    const list = await as(admin).budgets.list();
    expect(list.map((b) => [b.scope, b.spentUsd, b.pct]).sort()).toEqual([
      ['org', 1.5, 2],
      ['user', 1.5, 150],
    ]);
    expect((await as(dev).budgets.myStatus()).blocked).toBe(true);
    expect((await as(admin).budgets.myStatus()).blocked).toBe(false);
    expect(await code(as(dev).budgets.set({ scope: 'org', limitUsd: 5 }))).toBe('FORBIDDEN');
  });

  it('shows admins the whole org and developers only their own usage', async () => {
    await usage(dev.id, '1.000000');
    await usage(admin.id, '2.000000');
    const org = await as(admin).usage.summary();
    expect(org.scope).toBe('org');
    expect(org.total.costUsd).toBe('3.000000');
    expect(org.byUser.map((u) => u.login)).toEqual(['admin', 'dev']);
    expect(org.byRepo[0]!.fullName).toBe('acme/web');

    const mine = await as(dev).usage.summary();
    expect(mine.scope).toBe('mine');
    expect(mine.total.costUsd).toBe('1.000000');
    expect(mine.byUser.map((u) => u.login)).toEqual(['dev']);
  });
});

describe('members.setPrimaryTeam', () => {
  it('only accepts a team the member is in', async () => {
    const caller = as(admin);
    const team = await caller.teams.create({ name: 'Platform' });
    expect(await code(caller.members.setPrimaryTeam({ userId: dev.id, teamId: team.id }))).toBe('BAD_REQUEST');
    await caller.teams.addMember({ teamId: team.id, userId: dev.id });
    await caller.members.setPrimaryTeam({ userId: dev.id, teamId: team.id });
    expect((await caller.members.list()).find((m) => m.userId === dev.id)!.primaryTeamId).toBe(team.id);
  });
});
