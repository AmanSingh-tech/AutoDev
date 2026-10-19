import { eq, schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, ANTHROPIC, callerFor, createTestDeps, msw } from '../../test/harness';

const h = createTestDeps();
const { deps } = h;

beforeAll(() => msw.listen({ onUnhandledRequest: 'error' }));
afterAll(async () => {
  msw.close();
  await h.close();
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let dev: { id: string };
let other: { id: string };
let repoId: string;
beforeEach(async () => {
  await truncateAll(deps.sys);
  h.chatJobs.length = 0;
  msw.resetHandlers();
  fx = await makeOrg(deps.sys, 'acme');
  repoId = fx.repo.id;
  dev = await addMember(deps, fx.org.id, 'dev', 'developer');
  other = await addMember(deps, fx.org.id, 'other', 'developer');
  await grant(dev.id);
  await grant(other.id);
});

const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: { code?: string }) => e.code,
  );

async function grant(userId: string) {
  await deps.sys.insert(schema.userRepoAccess).values({
    userId,
    repoId,
    orgId: fx.org.id,
    permission: 'pull',
    fetchedAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
}

/** Gives the org a working Anthropic key, so asking is allowed. */
async function withKey() {
  msw.use(
    http.get(`${ANTHROPIC}/v1/models`, ({ request }) =>
      request.headers.get('x-api-key')?.startsWith('sk-ant-good')
        ? HttpResponse.json({ data: [], has_more: false })
        : HttpResponse.json(
            { type: 'error', error: { type: 'authentication_error', message: 'x' } },
            { status: 401 },
          ),
    ),
  );
  await as(fx.owner).llmKeys.create({
    scope: 'org',
    provider: 'anthropic',
    label: 'Company',
    apiKey: 'sk-ant-good-0123456789',
  });
}

describe('chat router', () => {
  it('asks a question: stores it with a pending reply and queues the answer', async () => {
    await withKey();
    const chat = await as(dev).chat.create({ repoId });
    expect(chat.title).toBe('New chat');

    const { questionId, replyId } = await as(dev).chat.ask({
      chatId: chat.id,
      question: 'How do we deploy?',
    });

    const { messages, title } = await as(dev).chat.messages({ chatId: chat.id });
    expect(title).toBe('How do we deploy?');
    expect(messages).toEqual([
      expect.objectContaining({
        id: questionId,
        role: 'user',
        status: 'done',
        content: 'How do we deploy?',
      }),
      expect.objectContaining({
        id: replyId,
        role: 'assistant',
        status: 'pending',
        content: '',
        replyToId: questionId,
      }),
    ]);
    expect(h.chatJobs).toEqual([
      {
        name: 'answer',
        data: { kind: 'answer', orgId: fx.org.id, messageId: replyId },
        jobId: `chat-${replyId}`,
      },
    ]);
  });

  it('allows one pending answer per chat', async () => {
    await withKey();
    const chat = await as(dev).chat.create({ repoId });
    await as(dev).chat.ask({ chatId: chat.id, question: 'First?' });
    expect(await code(as(dev).chat.ask({ chatId: chat.id, question: 'Second?' }))).toBe('CONFLICT');
  });

  it('keeps chats private to their author, even from other members of the org', async () => {
    await withKey();
    const chat = await as(dev).chat.create({ repoId });
    await as(dev).chat.ask({ chatId: chat.id, question: 'Private?' });

    expect(await code(as(other).chat.messages({ chatId: chat.id }))).toBe('NOT_FOUND');
    expect(await code(as(other).chat.ask({ chatId: chat.id, question: 'Me too?' }))).toBe(
      'NOT_FOUND',
    );
    expect(await as(other).chat.list({ repoId })).toEqual([]);
    expect(await as(dev).chat.list({ repoId })).toEqual([expect.objectContaining({ id: chat.id })]);
  });

  it('refuses to start a chat on a repo the caller cannot read', async () => {
    const [stranger] = await deps.sys
      .insert(schema.users)
      .values({ githubUserId: 9_100_001, githubLogin: 'stranger' })
      .returning();
    await deps.sys
      .insert(schema.orgMembers)
      .values({ orgId: fx.org.id, userId: stranger!.id, role: 'developer' });
    expect(await code(as(stranger!).chat.create({ repoId }))).toBe('FORBIDDEN');
  });

  it('will not queue a question when the org has no working key', async () => {
    const chat = await as(dev).chat.create({ repoId });
    expect(await code(as(dev).chat.ask({ chatId: chat.id, question: 'Anyone?' }))).toBe(
      'PRECONDITION_FAILED',
    );
    expect(h.chatJobs).toHaveLength(0);
  });
});

describe('team room', () => {
  it('is shared: everyone with access reads the same room, and plain messages queue nothing', async () => {
    await as(dev).room.post({ repoId, content: 'Deploy at 5pm' });
    const seen = await as(other).room.get({ repoId });
    expect(seen.messages).toEqual([expect.objectContaining({ author: 'user', status: 'done', content: 'Deploy at 5pm', login: 'dev' })]);
    expect((await as(dev).room.get({ repoId })).channelId).toBe(seen.channelId);
    expect(h.chatJobs).toHaveLength(0);
  });

  it('a mention of @agent adds a pending agent reply and queues it, one at a time per person', async () => {
    await withKey();
    const { messageId, agentReplyId } = await as(dev).room.post({ repoId, content: '@agent how do we deploy?' });
    expect(agentReplyId).toBeTruthy();
    const { messages } = await as(other).room.get({ repoId });
    expect(messages.at(-1)).toMatchObject({ id: agentReplyId, author: 'agent', status: 'pending', replyToId: messageId, login: 'dev' });
    expect(h.chatJobs).toEqual([{ name: 'room', data: { kind: 'room', orgId: fx.org.id, messageId: agentReplyId }, jobId: `room-${agentReplyId}` }]);

    expect(await code(as(dev).room.post({ repoId, content: '@agent and another?' }))).toBe('CONFLICT');
    // Someone else can still ask, and anyone can keep talking.
    expect(await code(as(other).room.post({ repoId, content: '@Agent me too' }))).toBe('OK');
    expect(await code(as(dev).room.post({ repoId, content: 'thanks, waiting' }))).toBe('OK');
  });

  it('does not treat an email address as a mention, and a mention needs a working key', async () => {
    expect((await as(dev).room.post({ repoId, content: 'mail ops@agent.io' })).agentReplyId).toBeNull();
    expect(await code(as(dev).room.post({ repoId, content: '@agent hello' }))).toBe('PRECONDITION_FAILED');
  });

  it('is closed to members without access to the repo', async () => {
    const [stranger] = await deps.sys.insert(schema.users).values({ githubUserId: 9_100_002, githubLogin: 'stranger' }).returning();
    await deps.sys.insert(schema.orgMembers).values({ orgId: fx.org.id, userId: stranger!.id, role: 'developer' });
    expect(await code(as(stranger!).room.get({ repoId }))).toBe('FORBIDDEN');
    expect(await code(as(stranger!).room.post({ repoId, content: 'hi' }))).toBe('FORBIDDEN');
  });
});

describe('repo agent memory', () => {
  /** Lets `userId` push to the repo, with the access cache marked fresh so no GitHub call is made. */
  async function canPush(userId: string) {
    await deps.sys.update(schema.userRepoAccess).set({ permission: 'push' }).where(eq(schema.userRepoAccess.userId, userId));
    await deps.cache.set(`repo-access:fresh:${fx.org.id}:0:${userId}`, '1', 3600);
  }

  it('starts with four empty sections that everyone with access can read', async () => {
    await deps.cache.set(`repo-access:fresh:${fx.org.id}:0:${dev.id}`, '1', 3600);
    const m = await as(dev).repoAgent.memory.get({ repoId });
    expect(m.canEdit).toBe(false);
    expect(m.sections.map((s) => [s.section, s.contentMd])).toEqual([
      ['conventions', ''],
      ['architecture', ''],
      ['rules', ''],
      ['fragile_areas', ''],
    ]);
  });

  it('is edited by people who can push, and by admins; others are refused; edits are audited', async () => {
    await canPush(dev.id);
    await deps.cache.set(`repo-access:fresh:${fx.org.id}:0:${other.id}`, '1', 3600);
    await as(dev).repoAgent.memory.update({ repoId, section: 'rules', contentMd: 'No default exports.' });
    await as(dev).repoAgent.memory.update({ repoId, section: 'rules', contentMd: 'No default exports. Use zod.' });
    expect(await code(as(other).repoAgent.memory.update({ repoId, section: 'rules', contentMd: 'x' }))).toBe('FORBIDDEN');

    const m = await as(other).repoAgent.memory.get({ repoId });
    expect(m.sections.find((s) => s.section === 'rules')).toMatchObject({ contentMd: 'No default exports. Use zod.', updatedBy: 'dev' });
    const audits = await deps.sys.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'repo_agent_memory.updated'));
    expect(audits).toHaveLength(2);

    // The org owner is an admin; with access to the repo they can edit without push.
    await grant(fx.owner.id);
    expect(await code(as(fx.owner).repoAgent.memory.update({ repoId, section: 'fragile_areas', contentMd: 'Billing.' }))).toBe('OK');
  });
});
