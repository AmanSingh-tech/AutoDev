import { and, eq, isNotNull, lt, or, schema, sql, type SystemDb } from '@autodev/db';

const { agentRuns, chatMessages, notifications, orgs } = schema;

export interface RetentionResult {
  orgId: string;
  chatMessages: number;
  channelMessages: number;
  agentSteps: number;
  transcripts: number;
  notifications: number;
}

const BATCH = 5_000;
const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);

/** Deletes in batches so a first run over years of data doesn't hold one huge lock. */
async function deleteInBatches(run: () => Promise<{ n: number }[]>): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await run();
    total += rows.length;
    if (rows.length < BATCH) return total;
  }
}

/**
 * Applies one org's retention (B-7): chat (private and team room), agent traces (steps and the
 * transcript blobs, which the blob sweep then removes) and notifications older than the org's
 * setting. Null keeps forever. The audit log is never purged.
 */
export async function purgeOrg(sys: SystemDb, orgId: string, now = new Date()): Promise<RetentionResult> {
  const [org] = await sys
    .select({ chat: orgs.chatRetentionDays, trace: orgs.agentTraceRetentionDays, notes: orgs.notificationRetentionDays })
    .from(orgs)
    .where(eq(orgs.id, orgId));
  const result: RetentionResult = { orgId, chatMessages: 0, channelMessages: 0, agentSteps: 0, transcripts: 0, notifications: 0 };
  if (!org) return result;

  if (org.chat) {
    const before = daysAgo(now, org.chat);
    // Replies point at their parent; detach them first so deleting the parent can't fail.
    await sys.update(chatMessages).set({ replyToId: null }).where(and(eq(chatMessages.orgId, orgId), sql`${chatMessages.replyToId} in (select id from chat_messages where org_id = ${orgId} and created_at < ${before.toISOString()})`));
    result.chatMessages = await deleteInBatches(() =>
      sys.execute<{ n: number }>(sql`delete from chat_messages where id in (select id from chat_messages where org_id = ${orgId} and created_at < ${before.toISOString()} limit ${BATCH}) returning 1 as n`),
    );
    result.channelMessages = await deleteInBatches(() =>
      sys.execute<{ n: number }>(sql`delete from channel_messages where id in (select id from channel_messages where org_id = ${orgId} and created_at < ${before.toISOString()} limit ${BATCH}) returning 1 as n`),
    );
  }

  if (org.trace) {
    const before = daysAgo(now, org.trace);
    result.agentSteps = await deleteInBatches(() =>
      sys.execute<{ n: number }>(sql`delete from agent_steps where id in (select id from agent_steps where org_id = ${orgId} and created_at < ${before.toISOString()} limit ${BATCH}) returning 1 as n`),
    );
    // Only finished runs: a paused run resumes from its transcript.
    const cleared = await sys
      .update(agentRuns)
      .set({ transcriptHash: null })
      .where(and(eq(agentRuns.orgId, orgId), isNotNull(agentRuns.transcriptHash), lt(agentRuns.endedAt, before)))
      .returning({ id: agentRuns.id });
    result.transcripts = cleared.length;
  }

  if (org.notes) {
    const before = daysAgo(now, org.notes);
    const gone = await sys.delete(notifications).where(and(eq(notifications.orgId, orgId), lt(notifications.createdAt, before))).returning({ id: notifications.id });
    result.notifications = gone.length;
  }
  return result;
}

/** Every org with some retention set. */
export async function purgeAll(sys: SystemDb, now = new Date()): Promise<RetentionResult[]> {
  const list = await sys
    .select({ id: orgs.id })
    .from(orgs)
    .where(or(isNotNull(orgs.chatRetentionDays), isNotNull(orgs.agentTraceRetentionDays), isNotNull(orgs.notificationRetentionDays)));
  const out: RetentionResult[] = [];
  for (const o of list) out.push(await purgeOrg(sys, o.id, now));
  return out;
}
