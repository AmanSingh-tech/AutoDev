import { and, desc, eq, schema, type Tx } from '@autodev/db';
import { mentionsAgent } from '@autodev/agent';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { orgProcedure, router } from '../trpc';
import { assertCanAsk, MAX_QUESTION_CHARS, readableRepo } from './chat';

const { channelMessages, repoChannels, users } = schema;

/** Messages shown when the room opens. Older history is kept but not paged yet. */
const ROOM_PAGE = 100;

/** The repo's room, created on first use. Two people opening it at once both get the same row. */
async function roomFor(tx: Tx, orgId: string, repoId: string) {
  await tx.insert(repoChannels).values({ orgId, repoId }).onConflictDoNothing();
  const [room] = await tx.select().from(repoChannels).where(eq(repoChannels.repoId, repoId));
  return room!;
}

/**
 * The shared team room of a repo: everyone in the org with access to the repo reads and posts.
 * A message that mentions @agent queues an answer from the Repo Agent, which runs on the poster's
 * GitHub access, key and budget. RLS (migration 0023) enforces the same access rule.
 */
export const roomRouter = router({
  get: orgProcedure.input(z.object({ repoId: z.string().uuid() })).query(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      await readableRepo(tx, ctx.orgId, ctx.userId, input.repoId);
      const room = await roomFor(tx, ctx.orgId, input.repoId);
      const rows = await tx
        .select({
          id: channelMessages.id,
          author: channelMessages.author,
          status: channelMessages.status,
          content: channelMessages.content,
          citations: channelMessages.citations,
          commitSha: channelMessages.commitSha,
          replyToId: channelMessages.replyToId,
          createdAt: channelMessages.createdAt,
          userId: channelMessages.userId,
          login: users.githubLogin,
          avatarUrl: users.avatarUrl,
        })
        .from(channelMessages)
        .innerJoin(users, eq(users.id, channelMessages.userId))
        .where(and(eq(channelMessages.orgId, ctx.orgId), eq(channelMessages.channelId, room.id)))
        .orderBy(desc(channelMessages.createdAt))
        .limit(ROOM_PAGE);
      return { channelId: room.id, messages: rows.reverse() };
    }),
  ),

  post: orgProcedure
    .input(z.object({ repoId: z.string().uuid(), content: z.string().trim().min(1).max(MAX_QUESTION_CHARS) }))
    .mutation(async ({ ctx, input }) => {
      const askAgent = mentionsAgent(input.content);
      if (askAgent) await assertCanAsk(ctx);

      const { message, reply } = await ctx.inOrg(async (tx) => {
        await readableRepo(tx, ctx.orgId, ctx.userId, input.repoId);
        const room = await roomFor(tx, ctx.orgId, input.repoId);
        const base = { orgId: ctx.orgId, channelId: room.id, repoId: input.repoId, userId: ctx.userId };
        if (askAgent) {
          const [waiting] = await tx
            .select({ id: channelMessages.id })
            .from(channelMessages)
            .where(and(eq(channelMessages.channelId, room.id), eq(channelMessages.userId, ctx.userId), eq(channelMessages.author, 'agent'), eq(channelMessages.status, 'pending')));
          if (waiting) throw new TRPCError({ code: 'CONFLICT', message: 'The Repo Agent is still answering your last question. Wait for it before asking another.' });
        }
        const [message] = await tx.insert(channelMessages).values({ ...base, author: 'user', content: input.content }).returning({ id: channelMessages.id });
        const reply = askAgent
          ? (await tx.insert(channelMessages).values({ ...base, author: 'agent', status: 'pending', replyToId: message!.id }).returning({ id: channelMessages.id }))[0]
          : undefined;
        return { message: message!, reply };
      });

      if (reply) await ctx.deps.queues.chat.add('room', { kind: 'room', orgId: ctx.orgId, messageId: reply.id }, { jobId: `room-${reply.id}` });
      return { messageId: message.id, agentReplyId: reply?.id ?? null };
    }),
});
