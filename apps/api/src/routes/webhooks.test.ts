import { eq, schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, createTestDeps, testCfg } from '../../test/harness';
import { buildServer } from '../server';

const h = createTestDeps();
const app = await buildServer(h.deps, { logger: false });
afterAll(async () => {
  await app.close();
  await h.close();
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
beforeEach(async () => {
  await truncateAll(h.deps.sys);
  fx = await makeOrg(h.deps.sys, 'acme');
  h.jobs.length = 0;
});

function send(event: string, payload: object, opts: { delivery?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + createHmac('sha256', opts.secret ?? testCfg.webhookSecret).update(body).digest('hex');
  return app.inject({
    method: 'POST',
    url: '/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': opts.delivery ?? randomUUID(),
      'x-hub-signature-256': sig,
    },
    payload: body,
  });
}

const inst = () => ({ id: fx.installation.githubInstallationId });

describe('POST /webhooks/github', () => {
  it('rejects a bad signature without touching state', async () => {
    const res = await send('installation', { action: 'deleted', installation: inst() }, { secret: 'wrong-secret-123456' });
    expect(res.statusCode).toBe(401);
    const [row] = await h.deps.sys.select().from(schema.installations).where(eq(schema.installations.id, fx.installation.id));
    expect(row!.deletedAt).toBeNull();
  });

  it('soft-deletes the installation and its repos on uninstall, with an audit entry', async () => {
    const res = await send('installation', { action: 'deleted', installation: inst() });
    expect(res.json()).toEqual({ result: 'installation:deleted' });
    const [repo] = await h.deps.sys.select().from(schema.repos).where(eq(schema.repos.id, fx.repo.id));
    expect(repo!.deletedAt).not.toBeNull();
    const audits = await h.deps.sys.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'installation.deleted'));
    expect(audits).toHaveLength(1);
  });

  it('processes each delivery once', async () => {
    const delivery = randomUUID();
    await send('installation_repositories', { action: 'added', installation: inst() }, { delivery });
    const again = await send('installation_repositories', { action: 'added', installation: inst() }, { delivery });
    expect(again.json()).toEqual({ result: 'duplicate' });
    expect(h.jobs).toEqual([{ name: 'installation', data: { kind: 'installation', githubInstallationId: fx.installation.githubInstallationId } }]);
  });

  it('invalidates the cached access of a collaborator whose permission changed', async () => {
    const dev = await addMember(h.deps, fx.org.id, 'dev', 'developer');
    const now = new Date();
    await h.deps.sys.insert(schema.userRepoAccess).values({
      userId: dev.id,
      repoId: fx.repo.id,
      orgId: fx.org.id,
      permission: 'push',
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + 900_000),
    });
    await send('member', { action: 'edited', member: { id: dev.githubUserId }, installation: inst() });
    const [row] = await h.deps.sys.select().from(schema.userRepoAccess).where(eq(schema.userRepoAccess.userId, dev.id));
    expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('removes the member when they leave the GitHub org', async () => {
    const dev = await addMember(h.deps, fx.org.id, 'dev', 'developer');
    await send('organization', {
      action: 'member_removed',
      membership: { user: { id: dev.githubUserId } },
      installation: inst(),
    });
    const [m] = await h.deps.sys.select().from(schema.orgMembers).where(eq(schema.orgMembers.userId, dev.id));
    expect(m!.status).toBe('removed');
  });

  it('ignores events for installations we do not know', async () => {
    const res = await send('repository', { action: 'renamed', installation: { id: 123456789 } });
    expect(res.json()).toEqual({ result: 'ignored:unknown_installation' });
  });
});
