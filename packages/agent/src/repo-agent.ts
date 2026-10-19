import { and, desc, eq, lt, schema } from '@autodev/db';
import { converse, openScope, RepoChatError, systemPrompt, type RepoQaDeps } from './repo-qa';
import { userMessage } from './repo-chat';

const { channelMessages, users } = schema;

/** How the team room addresses the agent. */
export const AGENT_MENTION = /(^|[^\w@])@agent\b/i;
export const mentionsAgent = (text: string) => AGENT_MENTION.test(text);
/** Earlier room messages the agent sees for context. */
export const ROOM_CONTEXT = 15;

/**
 * The Repo Agent: one per repo, answering in the repo's team room when mentioned. It uses the
 * repo's memory notes and the same read-only tools as private chat, and runs on the GitHub access,
 * key and budget of the person who mentioned it.
 *
 * It only answers questions for now. Other capabilities (AI review is the planned one) are meant
 * to be added as further methods here, sharing the scope, memory and tools in repo-qa.ts.
 */
export class RepoAgent {
  constructor(private readonly deps: RepoQaDeps) {}

  /** Answers one pending agent message in a team room. Idempotent, like private chat. */
  async answerInRoom(orgId: string, messageId: string): Promise<void> {
    const { sys } = this.deps;
    const [reply] = await sys
      .select()
      .from(channelMessages)
      .where(and(eq(channelMessages.id, messageId), eq(channelMessages.orgId, orgId)));
    if (!reply || reply.author !== 'agent' || reply.status !== 'pending' || !reply.replyToId) return;

    try {
      const [mention] = await sys.select().from(channelMessages).where(eq(channelMessages.id, reply.replyToId));
      if (!mention) throw new RepoChatError('The message I was asked about is gone.');
      const scope = await openScope(this.deps, orgId, reply.userId, reply.repoId);
      const room = await this.transcript(orgId, reply.channelId, mention.createdAt);
      const [asker] = await sys.select({ login: users.githubLogin }).from(users).where(eq(users.id, mention.userId));
      const prompt = [
        room ? `Recent messages in the team room, oldest first:\n${room}` : 'The team room has no earlier messages.',
        `@${asker?.login ?? 'someone'} mentioned you:\n${mention.content}`,
      ].join('\n\n');

      const { text, citations } = await converse(this.deps, scope, systemPrompt(scope, 'room'), [{ role: 'user', content: [{ type: 'text', text: prompt }] }]);
      await sys
        .update(channelMessages)
        .set({ status: 'done', content: text, citations, commitSha: scope.baseSha, completedAt: new Date() })
        .where(eq(channelMessages.id, reply.id));
    } catch (e) {
      await sys
        .update(channelMessages)
        .set({ status: 'failed', content: `I couldn't answer this. ${userMessage(e)}`, error: e instanceof Error ? e.message : String(e), completedAt: new Date() })
        .where(eq(channelMessages.id, reply.id));
    }
  }

  /** The room before the mention, as plain lines. Pending and failed agent answers are left out. */
  private async transcript(orgId: string, channelId: string, before: Date): Promise<string> {
    const rows = await this.deps.sys
      .select({ author: channelMessages.author, status: channelMessages.status, content: channelMessages.content, login: users.githubLogin })
      .from(channelMessages)
      .innerJoin(users, eq(users.id, channelMessages.userId))
      .where(and(eq(channelMessages.orgId, orgId), eq(channelMessages.channelId, channelId), eq(channelMessages.status, 'done'), lt(channelMessages.createdAt, before)))
      .orderBy(desc(channelMessages.createdAt))
      .limit(ROOM_CONTEXT);
    return rows
      .reverse()
      .map((r) => `[${r.author === 'agent' ? 'Repo Agent' : `@${r.login}`}] ${r.content}`)
      .join('\n');
  }
}
