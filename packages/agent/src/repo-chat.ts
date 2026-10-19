import { and, asc, eq, lt, schema } from '@autodev/db';
import { LlmBlocked, type Message } from '@autodev/llm';
import { converse, openScope, RepoChatError, systemPrompt, type RepoQaDeps } from './repo-qa';

export { CHAT_MAX_TURNS, CHAT_TOOLS, RepoChatError } from './repo-qa';
export type { RepoQaDeps as RepoChatDeps } from './repo-qa';

const { chatMessages, chatSessions } = schema;

/** Earlier messages sent with each question, so follow-ups make sense. */
export const CHAT_HISTORY = 12;

/**
 * Answers one pending message of a private repo chat, as the chat's author: their GitHub access,
 * their key and budget. The repo is read at the default branch's current commit.
 */
export class RepoChatRunner {
  constructor(private readonly deps: RepoQaDeps) {}

  /** Idempotent: a message that isn't pending is already answered, so retries are safe. */
  async answer(orgId: string, messageId: string): Promise<void> {
    const { sys } = this.deps;
    const [reply] = await sys
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.id, messageId), eq(chatMessages.orgId, orgId)));
    if (!reply || reply.role !== 'assistant' || reply.status !== 'pending' || !reply.replyToId) return;

    try {
      const [session] = await sys
        .select()
        .from(chatSessions)
        .where(and(eq(chatSessions.id, reply.sessionId), eq(chatSessions.orgId, orgId)));
      const [question] = await sys.select().from(chatMessages).where(eq(chatMessages.id, reply.replyToId));
      if (!session || !question) throw new RepoChatError('This chat is no longer available.');

      const scope = await openScope(this.deps, orgId, session.userId, session.repoId);
      const messages: Message[] = [
        ...(await this.history(orgId, session.id, question.createdAt)),
        { role: 'user', content: [{ type: 'text', text: question.content }] },
      ];
      const { text, citations } = await converse(this.deps, scope, systemPrompt(scope, 'private'), messages);

      await sys
        .update(chatMessages)
        .set({ status: 'done', content: text, citations, commitSha: scope.baseSha, completedAt: new Date() })
        .where(eq(chatMessages.id, reply.id));
      await sys.update(chatSessions).set({ updatedAt: new Date() }).where(eq(chatSessions.id, session.id));
    } catch (e) {
      await sys
        .update(chatMessages)
        .set({ status: 'failed', content: `I couldn't answer this. ${userMessage(e)}`, error: e instanceof Error ? e.message : String(e), completedAt: new Date() })
        .where(eq(chatMessages.id, reply.id));
    }
  }

  /** Completed earlier turns of this chat, oldest first. Failed and pending replies are left out. */
  private async history(orgId: string, sessionId: string, before: Date): Promise<Message[]> {
    const rows = await this.deps.sys
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(and(eq(chatMessages.orgId, orgId), eq(chatMessages.sessionId, sessionId), eq(chatMessages.status, 'done'), lt(chatMessages.createdAt, before)))
      .orderBy(asc(chatMessages.createdAt));
    return rows.slice(-CHAT_HISTORY).map((r) => ({ role: r.role, content: [{ type: 'text', text: r.content }] }));
  }
}

/** What the person sees when an answer fails. Internal errors are not shown. */
export function userMessage(e: unknown): string {
  return e instanceof RepoChatError || e instanceof LlmBlocked ? e.message : 'Something went wrong while reading the repository. Try again.';
}
