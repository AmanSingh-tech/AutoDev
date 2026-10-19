import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, truncateAll } from '../test/fixtures';
import { TEST_APP_URL, TEST_SYSTEM_URL } from '../test/env';
import { createAppDb, createSystemDb, withOrg } from './client';
import { channelMessages, chatMessages, chatSessions, orgMembers, repoAgentMemory, repoChannels, userRepoAccess, users } from './schema';

const sys = createSystemDb(TEST_SYSTEM_URL);
const app = createAppDb(TEST_APP_URL);
afterAll(async () => {
  await Promise.all([sys.close(), app.close()]);
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let author: { id: string };
let colleague: { id: string };
/** In the org, but without access to the repo on GitHub. */
let outsider: { id: string };
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  const made = await sys.db
    .insert(users)
    .values([
      { githubUserId: 9_200_001, githubLogin: 'author' },
      { githubUserId: 9_200_002, githubLogin: 'colleague' },
      { githubUserId: 9_200_003, githubLogin: 'outsider' },
    ])
    .returning();
  [author, colleague, outsider] = [made[0]!, made[1]!, made[2]!];
  await sys.db.insert(orgMembers).values(made.map((u) => ({ orgId: fx.org.id, userId: u.id, role: 'developer' as const })));
  const fresh = { orgId: fx.org.id, repoId: fx.repo.id, permission: 'push' as const, fetchedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) };
  await sys.db.insert(userRepoAccess).values([
    { ...fresh, userId: author.id },
    { ...fresh, userId: colleague.id },
  ]);

  const [chat] = await sys.db
    .insert(chatSessions)
    .values({ orgId: fx.org.id, repoId: fx.repo.id, userId: author.id, title: 'private' })
    .returning();
  await sys.db.insert(chatMessages).values({
    orgId: fx.org.id,
    sessionId: chat!.id,
    userId: author.id,
    role: 'user',
    content: 'secret question',
  });
  const [channel] = await sys.db.insert(repoChannels).values({ orgId: fx.org.id, repoId: fx.repo.id }).returning();
  await sys.db.insert(channelMessages).values({ orgId: fx.org.id, channelId: channel!.id, repoId: fx.repo.id, author: 'user', userId: author.id, content: 'hello team' });
  await sys.db.insert(repoAgentMemory).values({ orgId: fx.org.id, repoId: fx.repo.id, section: 'rules', contentMd: 'No default exports.' });
});

const as = <T>(u: { id: string }, fn: Parameters<typeof withOrg<T>>[3]) => withOrg(app.db, fx.org.id, u.id, fn);

describe('private chat RLS', () => {
  it('shows a chat and its messages only to the author, even inside the same org', async () => {
    expect(await as(author, (tx) => tx.select().from(chatSessions))).toHaveLength(1);
    expect(await as(author, (tx) => tx.select().from(chatMessages))).toHaveLength(1);
    expect(await as(colleague, (tx) => tx.select().from(chatSessions))).toEqual([]);
    expect(await as(colleague, (tx) => tx.select().from(chatMessages))).toEqual([]);
  });

  it('will not let a colleague write into the author’s chat', async () => {
    const [chat] = await sys.db.select().from(chatSessions).where(eq(chatSessions.userId, author.id));
    const changed = await as(colleague, (tx) =>
      tx.update(chatSessions).set({ title: 'hijacked' }).where(eq(chatSessions.id, chat!.id)).returning(),
    );
    expect(changed).toEqual([]);
  });
});

describe('team room and memory RLS', () => {
  it('shows the room and the memory to everyone with access to the repo, and to no one else', async () => {
    for (const u of [author, colleague]) {
      expect(await as(u, (tx) => tx.select().from(channelMessages))).toHaveLength(1);
      expect(await as(u, (tx) => tx.select().from(repoAgentMemory))).toHaveLength(1);
    }
    expect(await as(outsider, (tx) => tx.select().from(repoChannels))).toEqual([]);
    expect(await as(outsider, (tx) => tx.select().from(channelMessages))).toEqual([]);
    expect(await as(outsider, (tx) => tx.select().from(repoAgentMemory))).toEqual([]);
  });

  it('will not let someone without access post, and nobody can delete history', async () => {
    const [channel] = await sys.db.select().from(repoChannels);
    await expect(
      as(outsider, (tx) =>
        tx.insert(channelMessages).values({ orgId: fx.org.id, channelId: channel!.id, repoId: fx.repo.id, author: 'user', userId: outsider.id, content: 'hi' }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(as(author, (tx) => tx.delete(channelMessages))).rejects.toThrow(/permission denied/);
  });
});
