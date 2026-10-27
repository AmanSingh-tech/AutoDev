import { randomBytes } from 'node:crypto';
import { Envelope, last4 } from '@autodev/crypto';
import { and, eq, orgKeyContext, schema } from '@autodev/db';
import { adf, JIRA_ISSUE_KEY, JIRA_PROJECT_KEY, JIRA_SITE, JiraClient, JiraError, jiraTokenAad, withJira } from '@autodev/jira';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, orgProcedure, roleAtLeast, router } from '../trpc';

const { jiraConnections, orgs, tasks } = schema;

const jiraFailure = (e: unknown): never => {
  if (e instanceof JiraError) throw new TRPCError({ code: e.status === 400 ? 'BAD_REQUEST' : 'BAD_GATEWAY', message: e.message });
  throw e;
};

/**
 * Jira sync (B-7). Admins connect a Jira Cloud site; task owners and admins link a task to an issue
 * or create one from it. Status updates are pushed by the worker; Jira's webhook keeps the issue's
 * status on the task.
 */
export const jiraRouter = router({
  get: orgProcedure.query(async ({ ctx }) => {
    const [c] = await ctx.inOrg((tx) => tx.select().from(jiraConnections).where(eq(jiraConnections.orgId, ctx.orgId)));
    if (!c) return null;
    const isAdmin = roleAtLeast(ctx.role, 'admin');
    return {
      site: c.site,
      siteUrl: `https://${c.site}.atlassian.net`,
      email: c.email,
      tokenLast4: c.tokenLast4,
      defaultProject: c.defaultProject,
      lastError: c.lastError,
      lastSyncedAt: c.lastSyncedAt,
      // The webhook address carries a secret, so only admins see it.
      webhookUrl: isAdmin ? `${(ctx.deps.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '')}/webhooks/jira/${ctx.orgId}/${c.webhookToken}` : null,
    };
  }),

  /** Checks the credentials with Jira, then stores the token encrypted. A new token is optional on edits. */
  connect: adminProcedure
    .input(
      z.object({
        site: z.string().trim().toLowerCase().regex(JIRA_SITE, 'The part before .atlassian.net'),
        email: z.string().trim().email(),
        token: z.string().trim().min(10).max(500).optional(),
        defaultProject: z.string().trim().toUpperCase().regex(JIRA_PROJECT_KEY, 'A project key like WEB').nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.inOrg((tx) => tx.select().from(jiraConnections).where(eq(jiraConnections.orgId, ctx.orgId)));
      const [org] = await ctx.inOrg((tx) => tx.select({ wrapped: orgs.dataKeyWrapped, version: orgs.dataKeyVersion }).from(orgs).where(eq(orgs.id, ctx.orgId)));
      const env = new Envelope(ctx.deps.kms, org!.wrapped, orgKeyContext(ctx.orgId));
      let token = input.token;
      if (!token) {
        if (!existing) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Add an API token' });
        token = await env.useSecret(existing.tokenEnc, jiraTokenAad(ctx.orgId), (t) => t);
      }
      const client = new JiraClient({ site: input.site, email: input.email, token }, ctx.deps.env.JIRA_BASE_URL);
      const me = await client.myself().catch(jiraFailure);
      const values = {
        site: input.site,
        email: input.email,
        tokenEnc: await env.encrypt(token, jiraTokenAad(ctx.orgId)),
        dataKeyVersion: org!.version,
        tokenLast4: last4(token),
        defaultProject: input.defaultProject,
        lastError: null,
        updatedAt: new Date(),
      };
      await ctx.inOrg(async (tx) => {
        if (existing) await tx.update(jiraConnections).set(values).where(eq(jiraConnections.orgId, ctx.orgId));
        else await tx.insert(jiraConnections).values({ ...values, orgId: ctx.orgId, webhookToken: randomBytes(24).toString('base64url'), createdBy: ctx.userId });
        await ctx.audit(tx, { action: existing ? 'jira.updated' : 'jira.connected', targetType: 'org', targetId: ctx.orgId, metadata: { site: input.site, email: input.email, tokenChanged: !!input.token } });
      });
      return { account: me.displayName };
    }),

  disconnect: adminProcedure.mutation(({ ctx }) =>
    ctx.inOrg(async (tx) => {
      await tx.delete(jiraConnections).where(eq(jiraConnections.orgId, ctx.orgId));
      await ctx.audit(tx, { action: 'jira.disconnected', targetType: 'org', targetId: ctx.orgId });
      return { ok: true };
    }),
  ),

  /** Links a task to an existing issue (checked in Jira), or with `create`, files a new issue from the task. */
  link: orgProcedure
    .input(z.union([z.object({ key: z.string(), issueKey: z.string().trim().toUpperCase().regex(JIRA_ISSUE_KEY, 'An issue key like WEB-123') }), z.object({ key: z.string(), create: z.literal(true), project: z.string().trim().toUpperCase().regex(JIRA_PROJECT_KEY).optional() })]))
    .mutation(async ({ ctx, input }) => {
      const [t] = await ctx.inOrg((tx) => tx.select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.key, input.key))));
      if (!t) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      if (t.ownerId !== ctx.userId && !roleAtLeast(ctx.role, 'admin')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task owner or an admin can link it to Jira' });
      const [org] = await ctx.deps.sys.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, ctx.orgId));
      const issue = await withJira({ sys: ctx.deps.sys, kms: ctx.deps.kms, webUrl: ctx.deps.env.WEB_URL, baseUrl: ctx.deps.env.JIRA_BASE_URL }, ctx.orgId, async (client, conn) => {
        if ('issueKey' in input) return client.issue(input.issueKey);
        const project = input.project ?? conn.defaultProject;
        if (!project) throw new JiraError('Choose a Jira project (or set a default under Settings → Jira)', 400);
        const created = await client.createIssue({
          project,
          summary: t.title,
          description: adf([
            [{ text: t.descriptionMd.slice(0, 20_000) }],
            [{ text: 'Created from AutoDev task ' }, { text: t.key, href: `${ctx.deps.env.WEB_URL}/o/${org!.slug}/tasks/${t.key}` }, { text: '.' }],
          ]),
        });
        return client.issue(created.key);
      }).catch(jiraFailure);
      if (!issue) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Connect Jira first, under Settings → Jira' });
      await ctx.inOrg(async (tx) => {
        // jiraSyncedStatus null: the worker posts the current status on its next run.
        await tx.update(tasks).set({ jiraIssueKey: issue.key, jiraIssueStatus: issue.status, jiraSyncedStatus: null }).where(eq(tasks.id, t.id));
        await ctx.audit(tx, { action: 'create' in input ? 'task.jira_issue_created' : 'task.jira_linked', targetType: 'task', targetId: t.id, metadata: { issue: issue.key } });
      });
      return issue;
    }),

  unlink: orgProcedure.input(z.object({ key: z.string() })).mutation(async ({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      const [t] = await tx.select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.key, input.key)));
      if (!t) throw new TRPCError({ code: 'NOT_FOUND' });
      if (t.ownerId !== ctx.userId && !roleAtLeast(ctx.role, 'admin')) throw new TRPCError({ code: 'FORBIDDEN' });
      await tx.update(tasks).set({ jiraIssueKey: null, jiraIssueStatus: null, jiraSyncedStatus: null }).where(eq(tasks.id, t.id));
      await ctx.audit(tx, { action: 'task.jira_unlinked', targetType: 'task', targetId: t.id, metadata: { issue: t.jiraIssueKey } });
      return { ok: true };
    }),
  ),
});
