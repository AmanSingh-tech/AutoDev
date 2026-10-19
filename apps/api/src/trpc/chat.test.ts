import { schema } from '@autodev/db';
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
