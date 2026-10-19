import { and, asc, desc, eq, isNull, schema, type Tx } from '@autodev/db';
import { LlmBlocked } from '@autodev/llm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { orgProcedure, router } from '../trpc';

const { chatMessages, chatSessions, repos, userRepoAccess } = schema;

export const MAX_QUESTION_CHARS = 4000;
const NEW_CHAT_TITLE = 'New chat';

/** The repo, if it exists in the org and the caller has any access to it on GitHub. */
export async function readableRepo(tx: Tx, orgId: string, userId: string, repoId: string) {
  const [repo] = await tx
    .select({ id: repos.id, fullName: repos.fullName, defaultBranch: repos.defaultBranch })
    .from(repos)
    .where(and(eq(repos.id, repoId), eq(repos.orgId, orgId), isNull(repos.deletedAt)));
  if (!repo) throw new TRPCError({ code: 'NOT_FOUND', message: 'Repository not found' });
  const [access] = await tx
    .select({ repoId: userRepoAccess.repoId })
    .from(userRepoAccess)
    .where(and(eq(userRepoAccess.orgId, orgId), eq(userRepoAccess.userId, userId), eq(userRepoAccess.repoId, repo.id)));
  if (!access) throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this repository' });
  return repo;
}

/** Fails early, with the reason, when the caller's AI key or budget can't pay for an answer. */
export async function assertCanAsk(ctx: { deps: { gateway: { assertRunAllowed: (o: string, u: string, c: 'chat') => Promise<unknown> } }; orgId: string; userId: string }) {
  try {
    await ctx.deps.gateway.assertRunAllowed(ctx.orgId, ctx.userId, 'chat');
  } catch (e) {
    if (e instanceof LlmBlocked) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message, cause: e });
    throw e;
  }
}

/**
 * Private repo chat. Chats are private to their author: RLS and the owner filters below both enforce
 * it. Answers are produced by the worker (queue "chat"), so `ask` returns at once with a pending reply.
 */
export const chatRouter = router({
  /** The caller's own chats in one repo, most recent first. */
  list: orgProcedure.input(z.object({ repoId: z.string().uuid() })).query(({ ctx, input }) =>
    ctx.inOrg((tx) =>
      tx
        .select({ id: chatSessions.id, title: chatSessions.title, updatedAt: chatSessions.updatedAt })
        .from(chatSessions)
        .where(and(eq(chatSessions.orgId, ctx.orgId), eq(chatSessions.repoId, input.repoId), eq(chatSessions.userId, ctx.userId)))
        .orderBy(desc(chatSessions.updatedAt)),
    ),
  ),

  create: orgProcedure.input(z.object({ repoId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const [chat] = await ctx.inOrg(async (tx) => {
      const repo = await readableRepo(tx, ctx.orgId, ctx.userId, input.repoId);
      return tx
        .insert(chatSessions)
        .values({ orgId: ctx.orgId, repoId: repo.id, userId: ctx.userId, title: NEW_CHAT_TITLE })
        .returning({ id: chatSessions.id, title: chatSessions.title });
    });
    return chat!;
  }),

  /** One of the caller's chats, with its messages oldest first. Other people's chats read as not found. */
  messages: orgProcedure.input(z.object({ chatId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const [chat] = await ctx.inOrg((tx) =>
      tx
        .select({ id: chatSessions.id, title: chatSessions.title, repoId: chatSessions.repoId })
        .from(chatSessions)
        .where(and(eq(chatSessions.id, input.chatId), eq(chatSessions.orgId, ctx.orgId), eq(chatSessions.userId, ctx.userId))),
    );
    if (!chat) throw new TRPCError({ code: 'NOT_FOUND', message: 'Chat not found' });
    const messages = await ctx.inOrg((tx) =>
      tx
        .select({
          id: chatMessages.id,
          role: chatMessages.role,
          status: chatMessages.status,
          content: chatMessages.content,
          citations: chatMessages.citations,
          commitSha: chatMessages.commitSha,
          error: chatMessages.error,
          replyToId: chatMessages.replyToId,
          createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        .where(and(eq(chatMessages.sessionId, chat.id), eq(chatMessages.orgId, ctx.orgId)))
        .orderBy(asc(chatMessages.createdAt)),
    );
    return { ...chat, messages };
  }),

  /** Stores the question and a pending reply, then queues the answer. One answer at a time per chat. */
  ask: orgProcedure
    .input(z.object({ chatId: z.string().uuid(), question: z.string().trim().min(1).max(MAX_QUESTION_CHARS) }))
    .mutation(async ({ ctx, input }) => {
      await assertCanAsk(ctx);

      const { question, reply } = await ctx.inOrg(async (tx) => {
        const [chat] = await tx
          .select({ id: chatSessions.id, title: chatSessions.title })
          .from(chatSessions)
          .where(and(eq(chatSessions.id, input.chatId), eq(chatSessions.orgId, ctx.orgId), eq(chatSessions.userId, ctx.userId)));
        if (!chat) throw new TRPCError({ code: 'NOT_FOUND', message: 'Chat not found' });

        const [pending] = await tx
          .select({ id: chatMessages.id })
          .from(chatMessages)
          .where(and(eq(chatMessages.sessionId, chat.id), eq(chatMessages.status, 'pending')));
        if (pending) throw new TRPCError({ code: 'CONFLICT', message: 'Wait for the current answer before asking another question.' });

        const [question] = await tx
          .insert(chatMessages)
          .values({ orgId: ctx.orgId, sessionId: chat.id, userId: ctx.userId, role: 'user', status: 'done', content: input.question })
          .returning({ id: chatMessages.id });
        const [reply] = await tx
          .insert(chatMessages)
          .values({ orgId: ctx.orgId, sessionId: chat.id, userId: ctx.userId, role: 'assistant', status: 'pending', replyToId: question!.id })
          .returning({ id: chatMessages.id });
        await tx
          .update(chatSessions)
          .set({ updatedAt: new Date(), ...(chat.title === NEW_CHAT_TITLE ? { title: input.question.slice(0, 60) } : {}) })
          .where(eq(chatSessions.id, chat.id));
        return { question: question!, reply: reply! };
      });

      await ctx.deps.queues.chat.add('answer', { kind: 'answer', orgId: ctx.orgId, messageId: reply.id }, { jobId: `chat-${reply.id}` });
      return { questionId: question.id, replyId: reply.id };
    }),
});
