import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, truncateAll } from '../test/fixtures';
import { TEST_APP_URL, TEST_SYSTEM_URL } from '../test/env';
import { createAppDb, createSystemDb, withOrg } from './client';
import { orgMembers, repoChatMessages, repoChats, users } from './schema';

const sys = createSystemDb(TEST_SYSTEM_URL);
const app = createAppDb(TEST_APP_URL);
afterAll(async () => {
  await Promise.all([sys.close(), app.close()]);
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let author: { id: string };
let colleague: { id: string };
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  const [a] = await sys.db
    .insert(users)
    .values({ githubUserId: 9_200_001, githubLogin: 'author' })
    .returning();
  const [c] = await sys.db
    .insert(users)
    .values({ githubUserId: 9_200_002, githubLogin: 'colleague' })
    .returning();
  author = a!;
  colleague = c!;
  await sys.db.insert(orgMembers).values([
    { orgId: fx.org.id, userId: author.id, role: 'developer' },
    { orgId: fx.org.id, userId: colleague.id, role: 'developer' },
  ]);
  const [chat] = await sys.db
    .insert(repoChats)
    .values({ orgId: fx.org.id, repoId: fx.repo.id, userId: author.id, title: 'private' })
    .returning();
  await sys.db.insert(repoChatMessages).values({
    orgId: fx.org.id,
    chatId: chat!.id,
    userId: author.id,
    role: 'user',
    content: 'secret question',
  });
});

describe('repo chat RLS', () => {
  it('shows a chat and its messages only to the author, even inside the same org', async () => {
    const mine = await withOrg(app.db, fx.org.id, author.id, (tx) => tx.select().from(repoChats));
    expect(mine).toHaveLength(1);
    expect(
      await withOrg(app.db, fx.org.id, author.id, (tx) => tx.select().from(repoChatMessages)),
    ).toHaveLength(1);

    expect(
      await withOrg(app.db, fx.org.id, colleague.id, (tx) => tx.select().from(repoChats)),
    ).toEqual([]);
    expect(
      await withOrg(app.db, fx.org.id, colleague.id, (tx) => tx.select().from(repoChatMessages)),
    ).toEqual([]);
  });

  it('will not let a colleague write into the author’s chat', async () => {
    const [chat] = await sys.db.select().from(repoChats).where(eq(repoChats.userId, author.id));
    const changed = await withOrg(app.db, fx.org.id, colleague.id, (tx) =>
      tx.update(repoChats).set({ title: 'hijacked' }).where(eq(repoChats.id, chat!.id)).returning(),
    );
    expect(changed).toEqual([]);
  });
});
