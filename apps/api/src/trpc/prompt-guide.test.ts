import { schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { addMember, callerFor, createTestDeps } from '../../test/harness';

const h = createTestDeps();
const { deps } = h;

let fx: Awaited<ReturnType<typeof makeOrg>>;
let writer: { id: string };
let reader: { id: string };
beforeEach(async () => {
  await truncateAll(deps.sys);
  fx = await makeOrg(deps.sys, 'acme');
  writer = await addMember(deps, fx.org.id, 'writer', 'developer');
  reader = await addMember(deps, fx.org.id, 'reader', 'developer');
  // Mark both users' access as fresh in the cache (key format from RepoAccessService), so no GitHub call
  // is needed. Only the writer can push.
  for (const u of [writer, reader])
    await deps.cache.set(`repo-access:fresh:${fx.org.id}:0:${u.id}`, '1', 3600);
  const fresh = {
    orgId: fx.org.id,
    repoId: fx.repo.id,
    fetchedAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
  };
  await deps.sys.insert(schema.userRepoAccess).values([
    { ...fresh, userId: writer.id, permission: 'push' },
    { ...fresh, userId: reader.id, permission: 'pull' },
  ]);
});

const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: { code?: string }) => e.code,
  );
const input = () => ({
  repoId: fx.repo.id,
  title: 'Fix login',
  descriptionMd: 'It breaks.',
  acceptanceCriteriaMd: '',
});

describe('promptGuide.review', () => {
  it('is for people who can push to the repo', async () => {
    expect(await code(as(reader).promptGuide.review(input()))).toBe('FORBIDDEN');
  });

  it('needs a working key before it calls the model', async () => {
    expect(await code(as(writer).promptGuide.review(input()))).toBe('PRECONDITION_FAILED');
  });
});
