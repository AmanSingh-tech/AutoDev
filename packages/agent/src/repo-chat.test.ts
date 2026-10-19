import { makeOrg, testKms, TEST_APP_URL, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { MemoryCache, TokenVault, type GitHubConfig } from '@autodev/github';
import type { LlmGateway } from '@autodev/llm';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAppDb, createSystemDb, eq, schema } from '@autodev/db';
import { scripted, text, toolUse } from '../test/scripted';
import { RepoAgent } from './repo-agent';
import { CHAT_TOOLS, RepoChatRunner } from './repo-chat';
import { citationsFor } from './repo-qa';
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
      .filter((p) => p.startsWith(path ? `${path}/` : '') && !p.slice(path ? path.length + 1 : 0).includes('/'))
      .map((p) => ({ path: p, type: 'blob' as const, sha: `b-${p}` })),
  readBlob: async (sha) => Buffer.from(FILES[sha.slice(2)] ?? ''),
  search: async () => ['src/app.ts'],
  log: async (path) => [{ sha: 'c0ffee1234', title: `Touch ${path ?? 'everything'}`, author: 'alice', date: '2026-10-01T00:00:00Z' }],
};

let turns = scripted([]);
// The gateway takes (context, request, options); the scripted model only needs the request.
const gateway = {
  assertRunAllowed: async () => {},
  call: (_ctx: unknown, req: never) => turns.call(req),
} as unknown as LlmGateway;
const deps = { sys: sys.db, gateway, vault, cfg, cache, readerFor: () => reader };
const runner = new RepoChatRunner(deps);
const agent = new RepoAgent(deps);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(async () => {
  server.close();
  await Promise.all([sys.close(), app.close()]);
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  await vault.store(fx.owner.id, { accessToken: 'ghu_owner', refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null });
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
  const [session] = await sys.db.insert(schema.chatSessions).values({ orgId: fx.org.id, repoId: fx.repo.id, userId: fx.owner.id, title: 'chat' }).returning();
  const [q] = await sys.db
    .insert(schema.chatMessages)
    .values({ orgId: fx.org.id, sessionId: session!.id, userId: fx.owner.id, role: 'user', status: 'done', content: question })
    .returning();
  const [reply] = await sys.db
    .insert(schema.chatMessages)
    .values({ orgId: fx.org.id, sessionId: session!.id, userId: fx.owner.id, role: 'assistant', status: 'pending', replyToId: q!.id })
    .returning();
  return { sessionId: session!.id, replyId: reply!.id };
}

const reply = async (id: string) => (await sys.db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, id)))[0]!;

describe('RepoChatRunner', () => {
  it('reads files with the tools, answers with line citations at the commit, and records both', async () => {
    await grantAccess(fx.owner.id);
    turns = scripted([
      [toolUse('read_file', { path: 'src/nope.ts' })],
      [toolUse('read_file', { path: 'src/app.ts' })],
      [text('`src/app.ts:1` defines `greet`, which returns "hi".')],
    ]);
    const { replyId } = await askQuestion('What does greet return?');

    await runner.answer(fx.org.id, replyId);

    const r = await reply(replyId);
    expect(r).toMatchObject({ status: 'done', citations: [{ path: 'src/app.ts', startLine: 1, endLine: 1 }], commitSha: 'head-sha-0001', error: null });
    expect(r.content).toContain('greet');
    // The model saw the file with line numbers, and the bad path came back as a tool error.
    const [, second, third] = turns.requests;
    const results = (req: typeof second) => JSON.stringify(req!.messages.at(-1));
    expect(results(second)).toContain('No file at src/nope.ts');
    expect(results(third)).toContain('1: export const greet');
    expect(third!.tools).toEqual(CHAT_TOOLS);
  });

  it('puts the repo memory in the system prompt, and can read the commit history', async () => {
    await grantAccess(fx.owner.id);
    await sys.db.insert(schema.repoAgentMemory).values([
      { orgId: fx.org.id, repoId: fx.repo.id, section: 'rules', contentMd: 'Never call the payments API from the web app.' },
      { orgId: fx.org.id, repoId: fx.repo.id, section: 'architecture', contentMd: '   ' },
    ]);
    turns = scripted([[toolUse('git_log', { path: 'src/app.ts' })], [text('alice touched it.')]]);
    const { replyId } = await askQuestion('Who changed greet?');

    await runner.answer(fx.org.id, replyId);

    const system = JSON.stringify(turns.requests[0]!.system);
    expect(system).toContain('### Rules');
    expect(system).toContain('Never call the payments API');
    expect(system).not.toContain('### Architecture');
    expect(JSON.stringify(turns.requests[1]!.messages.at(-1))).toContain('c0ffee1 2026-10-01 alice: Touch src/app.ts');
  });

  it('sends earlier answers of the same chat along with the next question', async () => {
    await grantAccess(fx.owner.id);
    turns = scripted([[text('First answer.')], [text('Second answer.')]]);
    const first = await askQuestion('First question?');
    await runner.answer(fx.org.id, first.replyId);

    const [q2] = await sys.db
      .insert(schema.chatMessages)
      .values({ orgId: fx.org.id, sessionId: first.sessionId, userId: fx.owner.id, role: 'user', status: 'done', content: 'And the second?' })
      .returning();
    const [r2] = await sys.db
      .insert(schema.chatMessages)
      .values({ orgId: fx.org.id, sessionId: first.sessionId, userId: fx.owner.id, role: 'assistant', status: 'pending', replyToId: q2!.id })
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

    expect(await reply(replyId)).toMatchObject({ status: 'failed', content: expect.stringContaining('no longer have access') });
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

describe('RepoAgent in the team room', () => {
  async function roomWithMention() {
    const [channel] = await sys.db.insert(schema.repoChannels).values({ orgId: fx.org.id, repoId: fx.repo.id }).returning();
    const base = { orgId: fx.org.id, channelId: channel!.id, repoId: fx.repo.id, userId: fx.owner.id };
    await sys.db.insert(schema.channelMessages).values({ ...base, author: 'user', content: 'Deploy is at 5pm.', createdAt: new Date(Date.now() - 60_000) });
    await sys.db.insert(schema.channelMessages).values({ ...base, author: 'agent', status: 'failed', content: 'old failure', createdAt: new Date(Date.now() - 30_000) });
    const [mention] = await sys.db.insert(schema.channelMessages).values({ ...base, author: 'user', content: '@agent what does greet return?' }).returning();
    const [pending] = await sys.db.insert(schema.channelMessages).values({ ...base, author: 'agent', status: 'pending', replyToId: mention!.id }).returning();
    return pending!.id;
  }
  const roomMessage = async (id: string) => (await sys.db.select().from(schema.channelMessages).where(eq(schema.channelMessages.id, id)))[0]!;

  it('answers a mention with the room as context, as the person who mentioned it', async () => {
    await grantAccess(fx.owner.id);
    turns = scripted([[toolUse('read_file', { path: 'src/app.ts' })], [text('It returns "hi" (`src/app.ts:1`).')]]);
    const id = await roomWithMention();

    await agent.answerInRoom(fx.org.id, id);

    expect(await roomMessage(id)).toMatchObject({ status: 'done', citations: [{ path: 'src/app.ts', startLine: 1, endLine: 1 }], commitSha: 'head-sha-0001' });
    const prompt = JSON.stringify(turns.requests[0]!.messages);
    expect(prompt).toContain('[@acme-owner] Deploy is at 5pm.');
    expect(prompt).not.toContain('old failure');
    expect(prompt).toContain('@acme-owner mentioned you');
    expect(JSON.stringify(turns.requests[0]!.system)).toContain('You are the Repo Agent of the GitHub repository acme/web');
  });

  it('fails the answer, without calling the model, when the person who mentioned it lost access', async () => {
    turns = scripted([[text('should not be used')]]);
    const id = await roomWithMention();
    await agent.answerInRoom(fx.org.id, id);
    expect(await roomMessage(id)).toMatchObject({ status: 'failed', content: expect.stringContaining('no longer have access') });
    expect(turns.requests).toHaveLength(0);
  });
});

describe('citationsFor', () => {
  const known = new Set(['src/a.ts', 'docs/guide.md']);
  it('keeps cited ranges for files that exist, in any of the usual forms', () => {
    expect(citationsFor('See `src/a.ts:3-9`, src/a.ts#L12-L14, `./docs/guide.md:2` and `src/gone.ts:1`.', known, [])).toEqual([
      { path: 'src/a.ts', startLine: 3, endLine: 9 },
      { path: 'src/a.ts', startLine: 12, endLine: 14 },
      { path: 'docs/guide.md', startLine: 2, endLine: 2 },
    ]);
  });
  it('falls back to the files read when nothing is cited, and drops backwards ranges', () => {
    expect(citationsFor('No refs. `src/a.ts:9-3`', known, [{ path: 'src/a.ts', startLine: 1, endLine: 40 }, { path: 'src/a.ts', startLine: 41, endLine: 80 }])).toEqual([{ path: 'src/a.ts' }]);
  });
});
