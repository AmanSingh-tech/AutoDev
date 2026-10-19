import { makeOrg, testKms, TEST_APP_URL, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { MemoryCache, TokenVault, type GitHubConfig } from '@autodev/github';
import type { LlmGateway } from '@autodev/llm';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAppDb, createSystemDb, eq, schema } from '@autodev/db';
import { scripted, text, toolUse } from '../test/scripted';
import { CHAT_TOOLS, RepoChatRunner } from './repo-chat';
import type { RepoReader } from './repo-reader';

const API = 'http://github.test/api';
const cfg: GitHubConfig = {
  appId: 1,
  appSlug: 'x',
  privateKey: 'x',
  clientId: 'x',
  clientSecret: 'x',
  webhookSecret: 'x'.repeat(16),
  apiUrl: API,
  webUrl: 'http://github.test',
};
const sys = createSystemDb(TEST_SYSTEM_URL);
const app = createAppDb(TEST_APP_URL);
const server = setupServer();
const vault = new TokenVault(sys.db, testKms, cfg);
const cache = new MemoryCache();

const FILES: Record<string, string> = {
  'README.md': '# Web\nRun pnpm test.\n',
  'src/app.ts': 'export const greet = () => "hi";\n',
};

/** A reader over FILES: the chat logic under test, without GitHub in the way. */
const reader: RepoReader = {
  tree: async () => ({
    entries: Object.keys(FILES).map((path) => ({ path, type: 'blob' as const, sha: `b-${path}` })),
    truncated: false,
  }),
  listDir: async (path) =>
    Object.keys(FILES)
      .filter(
        (p) =>
          p.startsWith(path ? `${path}/` : '') &&
          !p.slice(path ? path.length + 1 : 0).includes('/'),
      )
      .map((p) => ({ path: p, type: 'blob' as const, sha: `b-${p}` })),
  readBlob: async (sha) => Buffer.from(FILES[sha.slice(2)] ?? ''),
  search: async () => ['src/app.ts'],
};

let turns = scripted([]);
// The gateway takes (context, request, options); the scripted model only needs the request.
const gateway = {
  assertRunAllowed: async () => {},
  call: (_ctx: unknown, req: never) => turns.call(req),
} as unknown as LlmGateway;
const runner = new RepoChatRunner({
  sys: sys.db,
  gateway,
  vault,
  cfg,
  cache,
  readerFor: () => reader,
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(async () => {
  server.close();
  await Promise.all([sys.close(), app.close()]);
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  await vault.store(fx.owner.id, {
    accessToken: 'ghu_owner',
    refreshToken: null,
    accessExpiresAt: null,
    refreshExpiresAt: null,
  });
  server.resetHandlers();
  server.use(
    http.get(`${API}/repos/acme/web/branches/:b`, ({ params }) =>
      HttpResponse.json({ name: params.b, commit: { sha: 'head-sha-0001' }, protected: false }),
    ),
  );
});

async function grantAccess(userId: string) {
  await sys.db.insert(schema.userRepoAccess).values({
    userId,
    repoId: fx.repo.id,
    orgId: fx.org.id,
    permission: 'pull',
    fetchedAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
}

/** A chat with one question waiting for an answer. Returns the ids the runner needs. */
async function askQuestion(question: string) {
  const [chat] = await sys.db
    .insert(schema.repoChats)
    .values({ orgId: fx.org.id, repoId: fx.repo.id, userId: fx.owner.id, title: 'chat' })
    .returning();
  const [q] = await sys.db
    .insert(schema.repoChatMessages)
    .values({
      orgId: fx.org.id,
      chatId: chat!.id,
      userId: fx.owner.id,
      role: 'user',
      status: 'done',
      content: question,
    })
    .returning();
  const [reply] = await sys.db
    .insert(schema.repoChatMessages)
    .values({
      orgId: fx.org.id,
      chatId: chat!.id,
      userId: fx.owner.id,
      role: 'assistant',
      status: 'pending',
      replyToId: q!.id,
    })
    .returning();
  return { chatId: chat!.id, replyId: reply!.id };
}

const reply = async (id: string) =>
  (
    await sys.db.select().from(schema.repoChatMessages).where(eq(schema.repoChatMessages.id, id))
  )[0]!;

describe('RepoChatRunner', () => {
  it('reads files with the tools, answers with sources, and records both', async () => {
    await grantAccess(fx.owner.id);
    turns = scripted([
      [toolUse('read_file', { path: 'src/nope.ts' })],
      [toolUse('read_file', { path: 'src/app.ts' })],
      [text('`src/app.ts:1` defines `greet`, which returns "hi".')],
    ]);
    const { replyId } = await askQuestion('What does greet return?');

    await runner.answer(fx.org.id, replyId);

    const r = await reply(replyId);
    expect(r).toMatchObject({ status: 'done', sources: ['src/app.ts'], error: null });
    expect(r.content).toContain('greet');
    // The model saw the file with line numbers, and the bad path came back as a tool error.
    const [, second, third] = turns.requests;
    const results = (req: typeof second) => JSON.stringify(req!.messages.at(-1));
    expect(results(second)).toContain('No file at src/nope.ts');
    expect(results(third)).toContain('1: export const greet');
    expect(third!.tools).toEqual(CHAT_TOOLS);
  });

  it('sends earlier answers of the same chat along with the next question', async () => {
    await grantAccess(fx.owner.id);
    turns = scripted([[text('First answer.')], [text('Second answer.')]]);
    const first = await askQuestion('First question?');
    await runner.answer(fx.org.id, first.replyId);

    const [q2] = await sys.db
      .insert(schema.repoChatMessages)
      .values({
        orgId: fx.org.id,
        chatId: first.chatId,
        userId: fx.owner.id,
        role: 'user',
        status: 'done',
        content: 'And the second?',
      })
      .returning();
    const [r2] = await sys.db
      .insert(schema.repoChatMessages)
      .values({
        orgId: fx.org.id,
        chatId: first.chatId,
        userId: fx.owner.id,
        role: 'assistant',
        status: 'pending',
        replyToId: q2!.id,
      })
      .returning();
    await runner.answer(fx.org.id, r2!.id);

    const messages = JSON.stringify(turns.requests[1]!.messages);
    expect(messages).toContain('First answer.');
    expect(messages).toContain('And the second?');
  });

  it('refuses people who no longer have access, without calling the model', async () => {
    const { replyId } = await askQuestion('Anything?');
    turns = scripted([[text('should not be used')]]);

    await runner.answer(fx.org.id, replyId);

    expect(await reply(replyId)).toMatchObject({
      status: 'failed',
      content: expect.stringContaining('no longer have access'),
    });
    expect(turns.requests).toHaveLength(0);
  });

  it('does nothing for a message that is already answered, so a retried job is safe', async () => {
    await grantAccess(fx.owner.id);
    turns = scripted([[text('Once.')], [text('Twice.')]]);
    const { replyId } = await askQuestion('Once?');
    await runner.answer(fx.org.id, replyId);
    await runner.answer(fx.org.id, replyId);

    expect(turns.requests).toHaveLength(1);
    expect((await reply(replyId)).content).toBe('Once.');
  });
});
