import { Envelope, type KeyWrapper } from '@autodev/crypto';
import { and, desc, eq, isNotNull, ne, or, orgKeyContext, schema, sql, type SystemDb } from '@autodev/db';
import { adf, JiraClient, JiraError } from './client';

const { jiraConnections, orgs, pullRequests, tasks } = schema;

export const jiraTokenAad = (orgId: string) => `jira:${orgId}`;

/** Status words people see in Jira comments. */
const STATUS_WORDS: Record<string, string> = {
  draft: 'a draft',
  queued: 'queued',
  planning: 'planning',
  awaiting_plan_approval: 'waiting for plan approval',
  designing: 'designing',
  awaiting_lld_approval: 'waiting for design approval',
  coding: 'coding',
  waiting_for_builder: 'waiting for a builder',
  testing: 'running tests',
  fixing: 'fixing test failures',
  needs_input: 'waiting for an answer',
  blocked_on_key: 'paused (AI key problem)',
  pushed: 'pushed',
  pr_open: 'in review (pull request open)',
  resolved: 'done',
  rejected: 'rejected',
  cancelled: 'cancelled',
  failed: 'failed',
};
export const describeStatus = (s: string) => STATUS_WORDS[s] ?? s.replace(/_/g, ' ');

export interface JiraDeps {
  sys: SystemDb;
  kms: KeyWrapper;
  webUrl: string;
  /** Test-only: where Jira is reached instead of <site>.atlassian.net. */
  baseUrl?: string;
}

/** The org's Jira client with the token decrypted for this use only, or null when not connected. */
export async function withJira<T>(deps: JiraDeps, orgId: string, fn: (client: JiraClient, conn: typeof jiraConnections.$inferSelect) => Promise<T>): Promise<T | null> {
  const [row] = await deps.sys
    .select({ conn: jiraConnections, wrapped: orgs.dataKeyWrapped })
    .from(jiraConnections)
    .innerJoin(orgs, eq(orgs.id, jiraConnections.orgId))
    .where(eq(jiraConnections.orgId, orgId));
  if (!row) return null;
  const env = new Envelope(deps.kms, row.wrapped, orgKeyContext(orgId));
  return env.useSecret(row.conn.tokenEnc, jiraTokenAad(orgId), (token) => fn(new JiraClient({ site: row.conn.site, email: row.conn.email, token }, deps.baseUrl), row.conn));
}

/**
 * Comments on each linked Jira issue whose task changed status since the last report, with the PR
 * link when there is one. Idempotent: the reported status is stored, so a retry doesn't repeat it.
 */
export async function pushTaskUpdates(deps: JiraDeps, orgId: string): Promise<{ orgId: string; commented: number; error?: string }> {
  const result = await withJira(deps, orgId, async (client) => {
    const pending = await deps.sys
      .select({ id: tasks.id, key: tasks.key, title: tasks.title, status: tasks.status, issue: tasks.jiraIssueKey, slug: orgs.slug })
      .from(tasks)
      .innerJoin(orgs, eq(orgs.id, tasks.orgId))
      .where(and(eq(tasks.orgId, orgId), isNotNull(tasks.jiraIssueKey), or(sql`${tasks.jiraSyncedStatus} is null`, ne(tasks.jiraSyncedStatus, sql`${tasks.status}::text`))))
      .limit(100);
    let commented = 0;
    for (const t of pending) {
      const [pr] = await deps.sys.select({ url: pullRequests.url, number: pullRequests.number }).from(pullRequests).where(eq(pullRequests.taskId, t.id)).orderBy(desc(pullRequests.createdAt)).limit(1);
      const taskUrl = `${deps.webUrl}/o/${t.slug}/tasks/${t.key}`;
      try {
        await client.comment(
          t.issue!,
          adf([
            [{ text: 'AutoDev task ' }, { text: t.key, href: taskUrl }, { text: ` is now ${describeStatus(t.status)}.` }],
            ...(pr ? [[{ text: 'Pull request: ' }, { text: `#${pr.number}`, href: pr.url }]] : []),
          ]),
        );
      } catch (e) {
        // An issue that's gone or no longer visible stops being synced, instead of failing every run.
        if (e instanceof JiraError && e.status === 404) {
          await deps.sys.update(tasks).set({ jiraSyncedStatus: t.status }).where(eq(tasks.id, t.id));
          continue;
        }
        throw e;
      }
      await deps.sys.update(tasks).set({ jiraSyncedStatus: t.status }).where(eq(tasks.id, t.id));
      commented++;
    }
    return commented;
  }).then(
    (n): { commented: number; error?: string } => ({ commented: n ?? 0 }),
    (e: Error) => ({ commented: 0, error: e.message }),
  );
  await deps.sys
    .update(jiraConnections)
    .set(result.error ? { lastError: result.error, updatedAt: new Date() } : { lastError: null, lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(jiraConnections.orgId, orgId));
  return { orgId, ...result };
}

export async function pushAllTaskUpdates(deps: JiraDeps) {
  const list = await deps.sys.select({ orgId: jiraConnections.orgId }).from(jiraConnections);
  const out = [];
  for (const c of list) out.push(await pushTaskUpdates(deps, c.orgId));
  return out;
}

/**
 * A Jira webhook (issue updated or deleted) for the org whose secret token is in the URL. Keeps the
 * issue's status on linked tasks; a deleted issue is unlinked.
 */
export async function applyJiraWebhook(sys: SystemDb, orgId: string, token: string, body: { webhookEvent?: string; issue?: { key?: string; fields?: { status?: { name?: string } } } }) {
  const [conn] = await sys.select({ token: jiraConnections.webhookToken }).from(jiraConnections).where(eq(jiraConnections.orgId, orgId));
  if (!conn || !timingSafeEqualStr(conn.token, token)) return 'forbidden' as const;
  const key = body.issue?.key;
  if (!key) return 'ignored' as const;
  if (body.webhookEvent === 'jira:issue_deleted') {
    await sys.update(tasks).set({ jiraIssueKey: null, jiraIssueStatus: null, jiraSyncedStatus: null }).where(and(eq(tasks.orgId, orgId), eq(tasks.jiraIssueKey, key)));
    return 'unlinked' as const;
  }
  const status = body.issue?.fields?.status?.name;
  if (!status) return 'ignored' as const;
  await sys.update(tasks).set({ jiraIssueStatus: status }).where(and(eq(tasks.orgId, orgId), eq(tasks.jiraIssueKey, key)));
  return 'status' as const;
}

function timingSafeEqualStr(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
