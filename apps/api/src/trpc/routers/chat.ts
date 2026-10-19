import { and, asc, desc, eq, isNull, schema } from '@autodev/db';
import { LlmBlocked } from '@autodev/llm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { orgProcedure, router } from '../trpc';

const { repoChatMessages, repoChats, repos, userRepoAccess } = schema;

export const MAX_QUESTION_CHARS = 4000;
const NEW_CHAT_TITLE = 'New chat';

/**
 * Repo chat. Chats are private to their author: RLS and the owner filters below both enforce it.
 * Answers are produced by the worker (queue "chat"), so `ask` returns at once with a pending reply.
 */
export const chatRouter = router({
  /** The caller's own chats in one repo, most recent first. */
  list: orgProcedure.input(z.object({ repoId: z.string().uuid() })).query(({ ctx, input }) =>
    ctx.inOrg((tx) =>
      tx
        .select({ id: repoChats.id, title: repoChats.title, updatedAt: repoChats.updatedAt })
        .from(repoChats)
        .where(
          and(
            eq(repoChats.orgId, ctx.orgId),
            eq(repoChats.repoId, input.repoId),
            eq(repoChats.userId, ctx.userId),
          ),
        )
        .orderBy(desc(repoChats.updatedAt)),
    ),
  ),

  create: orgProcedure
    .input(z.object({ repoId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [chat] = await ctx.inOrg(async (tx) => {
        const [repo] = await tx
          .select({ id: repos.id })
          .from(repos)
          .where(
            and(eq(repos.id, input.repoId), eq(repos.orgId, ctx.orgId), isNull(repos.deletedAt)),
          );
        if (!repo) throw new TRPCError({ code: 'NOT_FOUND', message: 'Repository not found' });
        const [access] = await tx
          .select({ repoId: userRepoAccess.repoId })
          .from(userRepoAccess)
          .where(
            and(
              eq(userRepoAccess.orgId, ctx.orgId),
              eq(userRepoAccess.userId, ctx.userId),
              eq(userRepoAccess.repoId, repo.id),
            ),
          );
        if (!access)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this repository',
          });
        return tx
          .insert(repoChats)
          .values({ orgId: ctx.orgId, repoId: repo.id, userId: ctx.userId, title: NEW_CHAT_TITLE })
          .returning({ id: repoChats.id, title: repoChats.title });
      });
      return chat!;
    }),

  /** One of the caller's chats, with its messages oldest first. Other people's chats read as not found. */
  messages: orgProcedure
    .input(z.object({ chatId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [chat] = await ctx.inOrg((tx) =>
        tx
          .select({ id: repoChats.id, title: repoChats.title, repoId: repoChats.repoId })
          .from(repoChats)
          .where(
            and(
              eq(repoChats.id, input.chatId),
              eq(repoChats.orgId, ctx.orgId),
              eq(repoChats.userId, ctx.userId),
            ),
          ),
      );
      if (!chat) throw new TRPCError({ code: 'NOT_FOUND', message: 'Chat not found' });
      const messages = await ctx.inOrg((tx) =>
        tx
          .select({
            id: repoChatMessages.id,
            role: repoChatMessages.role,
            status: repoChatMessages.status,
            content: repoChatMessages.content,
            sources: repoChatMessages.sources,
            error: repoChatMessages.error,
            replyToId: repoChatMessages.replyToId,
            createdAt: repoChatMessages.createdAt,
          })
          .from(repoChatMessages)
          .where(and(eq(repoChatMessages.chatId, chat.id), eq(repoChatMessages.orgId, ctx.orgId)))
          .orderBy(asc(repoChatMessages.createdAt)),
      );
      return { ...chat, messages };
    }),

  /** Stores the question and a pending reply, then queues the answer. One answer at a time per chat. */
  ask: orgProcedure
    .input(
      z.object({
        chatId: z.string().uuid(),
        question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await ctx.deps.gateway.assertRunAllowed(ctx.orgId, ctx.userId, 'chat');
      } catch (e) {
        if (e instanceof LlmBlocked)
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message, cause: e });
        throw e;
      }

      const { question, reply } = await ctx.inOrg(async (tx) => {
        const [chat] = await tx
          .select({ id: repoChats.id, title: repoChats.title })
          .from(repoChats)
          .where(
            and(
              eq(repoChats.id, input.chatId),
              eq(repoChats.orgId, ctx.orgId),
              eq(repoChats.userId, ctx.userId),
            ),
          );
        if (!chat) throw new TRPCError({ code: 'NOT_FOUND', message: 'Chat not found' });

        const [pending] = await tx
          .select({ id: repoChatMessages.id })
          .from(repoChatMessages)
          .where(and(eq(repoChatMessages.chatId, chat.id), eq(repoChatMessages.status, 'pending')));
        if (pending)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Wait for the current answer before asking another question.',
          });

        const [question] = await tx
          .insert(repoChatMessages)
          .values({
            orgId: ctx.orgId,
            chatId: chat.id,
            userId: ctx.userId,
            role: 'user',
            status: 'done',
            content: input.question,
          })
          .returning({ id: repoChatMessages.id });
        const [reply] = await tx
          .insert(repoChatMessages)
          .values({
            orgId: ctx.orgId,
            chatId: chat.id,
            userId: ctx.userId,
            role: 'assistant',
            status: 'pending',
            replyToId: question!.id,
          })
          .returning({ id: repoChatMessages.id });
        await tx
          .update(repoChats)
          .set({
            updatedAt: new Date(),
            ...(chat.title === NEW_CHAT_TITLE ? { title: input.question.slice(0, 60) } : {}),
          })
          .where(eq(repoChats.id, chat.id));
        return { question: question!, reply: reply! };
      });

      await ctx.deps.queues.chat.add(
        'answer',
        { kind: 'answer', orgId: ctx.orgId, messageId: reply.id },
        { jobId: `chat-${reply.id}` },
      );
      return { questionId: question.id, replyId: reply.id };
    }),
});
