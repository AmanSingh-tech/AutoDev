import { createSystemDb, eq, schema } from '@autodev/db';
import { makeOrg, testKms, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API, server, testCfg } from '../test/helpers';
import { completeLogin } from './login';
import { TokenVault } from './vault';

const sys = createSystemDb(TEST_SYSTEM_URL);
const vault = new TokenVault(sys.db, testKms, testCfg);
const deps = { sys: sys.db, vault, cfg: testCfg };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await sys.close();
});
beforeEach(() => truncateAll(sys.db));

const tokens = { accessToken: 'ghu_x', refreshToken: 'ghr_x', accessExpiresAt: null, refreshExpiresAt: null };
const profile = { id: 4242, login: 'newdev', name: 'New Dev', email: 'n@x.dev', avatar_url: null };

function github(opts: { installationIds: number[]; membership: Record<string, 'active' | 'pending' | null> }) {
  server.use(
    http.get(`${API}/user/installations`, () =>
      HttpResponse.json({
        total_count: opts.installationIds.length,
        installations: opts.installationIds.map((id) => ({ id })),
      }),
    ),
    http.get(`${API}/user/memberships/orgs/:org`, ({ params }) => {
      const state = opts.membership[params.org as string];
      return state
        ? HttpResponse.json({ state, role: 'member' })
        : new HttpResponse(null, { status: 404 });
    }),
  );
}

describe('completeLogin', () => {
  it('upserts the user, stores tokens, audits and auto-joins orgs as the default role', async () => {
    const acme = await makeOrg(sys.db, 'acme');
    const globex = await makeOrg(sys.db, 'globex');
    github({
      installationIds: [acme.installation.githubInstallationId, globex.installation.githubInstallationId],
      membership: { acme: 'active', globex: 'pending' },
    });

    const { userId } = await completeLogin(deps, { profile, tokens });

    const memberships = await sys.db.select().from(schema.orgMembers).where(eq(schema.orgMembers.userId, userId));
    expect(memberships.map((m) => [m.orgId, m.role])).toEqual([[acme.org.id, 'developer']]);
    await expect(vault.withToken(userId, async (t) => t)).resolves.toBe('ghu_x');
    const audit = await sys.db.select().from(schema.auditLog).where(eq(schema.auditLog.actorUserId, userId));
    expect(audit.map((a) => a.action).sort()).toEqual(['auth.login', 'member.auto_joined']);
  });

  it('updates the profile on repeat login and does not re-add a removed member', async () => {
    const acme = await makeOrg(sys.db, 'acme');
    github({ installationIds: [acme.installation.githubInstallationId], membership: { acme: 'active' } });
    const { userId } = await completeLogin(deps, { profile, tokens });
    await sys.db
      .update(schema.orgMembers)
      .set({ status: 'removed' })
      .where(eq(schema.orgMembers.userId, userId));

    const again = await completeLogin(deps, { profile: { ...profile, login: 'renamed' }, tokens });
    expect(again.userId).toBe(userId);
    const [u] = await sys.db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(u!.githubLogin).toBe('renamed');
    const [m] = await sys.db.select().from(schema.orgMembers).where(eq(schema.orgMembers.userId, userId));
    expect(m!.status).toBe('removed');
  });
});
