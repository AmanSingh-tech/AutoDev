import { Envelope, last4 } from '@autodev/crypto';
import { eq, orgKeyContext, schema, sql } from '@autodev/db';
import { assertOutboundUrl, OutboundUrlError, postOutbound, siemSecretAad, signSiemBody } from '@autodev/governance';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, router } from '../trpc';

const { orgs, siemDestinations } = schema;

const retentionDays = z.number().int().min(7).max(3650).nullable();

/**
 * Enterprise controls (B-7), admins only: retention, the IP allowlist, the data region (read-only)
 * and the SIEM destination for the audit log. The audit download is REST (routes/audit.ts).
 */
export const governanceRouter = router({
  get: adminProcedure.query(async ({ ctx }) => {
    const [org] = await ctx.inOrg((tx) =>
      tx
        .select({
          chatRetentionDays: orgs.chatRetentionDays,
          agentTraceRetentionDays: orgs.agentTraceRetentionDays,
          notificationRetentionDays: orgs.notificationRetentionDays,
          logRetentionDays: orgs.logRetentionDays,
          ipAllowlist: orgs.ipAllowlist,
          dataRegion: orgs.dataRegion,
        })
        .from(orgs)
        .where(eq(orgs.id, ctx.orgId)),
    );
    const [siem] = await ctx.inOrg((tx) =>
      tx
        .select({
          url: siemDestinations.url,
          secretLast4: siemDestinations.secretLast4,
          enabled: siemDestinations.enabled,
          lastSentAt: siemDestinations.lastSentAt,
          lastError: siemDestinations.lastError,
          failures: siemDestinations.failures,
        })
        .from(siemDestinations)
        .where(eq(siemDestinations.orgId, ctx.orgId)),
    );
    return { ...org!, deploymentRegion: ctx.deps.env.DATA_REGION ?? 'us', yourIp: ctx.ip, siem: siem ?? null };
  }),

  setRetention: adminProcedure
    .input(z.object({ chatRetentionDays: retentionDays, agentTraceRetentionDays: retentionDays, notificationRetentionDays: retentionDays }))
    .mutation(({ ctx, input }) =>
      ctx.inOrg(async (tx) => {
        await tx.update(orgs).set(input).where(eq(orgs.id, ctx.orgId));
        await ctx.audit(tx, { action: 'org.retention_updated', targetType: 'org', targetId: ctx.orgId, metadata: input });
        return { ok: true };
      }),
    ),

  /**
   * Replaces the allowlist. Entries are addresses or CIDR ranges, normalized by Postgres
   * (203.0.113.7 → 203.0.113.7/32, 10.1.2.3/8 → 10.0.0.0/8). A list that wouldn't include the
   * caller's own address is refused, so an admin can't lock everyone out by mistake.
   */
  setIpAllowlist: adminProcedure.input(z.object({ entries: z.array(z.string().trim().min(1).max(64)).max(200) })).mutation(async ({ ctx, input }) => {
    const normalized = new Set<string>();
    for (const entry of input.entries) {
      try {
        const [row] = await ctx.deps.sys.execute<{ n: string }>(sql`select network(${entry}::inet)::text as n`);
        normalized.add(row!.n);
      } catch {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `“${entry}” isn’t an IP address or CIDR range` });
      }
    }
    const list = [...normalized].sort();
    if (list.length) {
      const ip = ctx.ip?.startsWith('::ffff:') ? ctx.ip.slice(7) : ctx.ip;
      const [inside] = ip
        ? await ctx.deps.sys.execute<{ ok: boolean }>(sql`select ${ip}::inet <<= any(${`{${list.join(',')}}`}::cidr[]) as ok`).catch(() => [{ ok: false }])
        : [{ ok: false }];
      if (!inside?.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: `The list must include your own address (${ctx.ip ?? 'unknown'}), or you’d be locked out.` });
    }
    await ctx.inOrg(async (tx) => {
      await tx.update(orgs).set({ ipAllowlist: list }).where(eq(orgs.id, ctx.orgId));
      await ctx.audit(tx, { action: 'org.ip_allowlist_updated', targetType: 'org', targetId: ctx.orgId, metadata: { entries: list } });
    });
    return { entries: list };
  }),

  /** Creates or updates the SIEM endpoint. The secret is required the first time, then optional. */
  setSiem: adminProcedure
    .input(z.object({ url: z.string().trim().url().max(2000), secret: z.string().min(16).max(256).optional(), enabled: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      try {
        assertOutboundUrl(input.url, { allowPrivate: ctx.deps.env.OUTBOUND_ALLOW_PRIVATE === '1' });
      } catch (e) {
        if (e instanceof OutboundUrlError) throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
        throw e;
      }
      return ctx.inOrg(async (tx) => {
        const [existing] = await tx.select({ orgId: siemDestinations.orgId }).from(siemDestinations).where(eq(siemDestinations.orgId, ctx.orgId));
        if (!existing && !input.secret) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Add a signing secret (at least 16 characters)' });
        let secret = {};
        if (input.secret) {
          const [org] = await tx.select({ wrapped: orgs.dataKeyWrapped, version: orgs.dataKeyVersion }).from(orgs).where(eq(orgs.id, ctx.orgId));
          const env = new Envelope(ctx.deps.kms, org!.wrapped, orgKeyContext(ctx.orgId));
          secret = { secretEnc: await env.encrypt(input.secret, siemSecretAad(ctx.orgId)), dataKeyVersion: org!.version, secretLast4: last4(input.secret) };
        }
        if (existing) {
          await tx
            .update(siemDestinations)
            .set({ url: input.url, enabled: input.enabled, ...secret, lastError: null, failures: 0, updatedAt: new Date() })
            .where(eq(siemDestinations.orgId, ctx.orgId));
        } else {
          // New destinations start from now: the history is available as a download.
          await tx.insert(siemDestinations).values({
            orgId: ctx.orgId,
            url: input.url,
            enabled: input.enabled,
            ...(secret as { secretEnc: Buffer; dataKeyVersion: number; secretLast4: string }),
            cursorCreatedAt: new Date(),
            cursorId: '00000000-0000-0000-0000-000000000000',
          });
        }
        await ctx.audit(tx, { action: existing ? 'siem.updated' : 'siem.created', targetType: 'org', targetId: ctx.orgId, metadata: { url: input.url, enabled: input.enabled, secretChanged: !!input.secret } });
        return { ok: true };
      });
    }),

  removeSiem: adminProcedure.mutation(({ ctx }) =>
    ctx.inOrg(async (tx) => {
      await tx.delete(siemDestinations).where(eq(siemDestinations.orgId, ctx.orgId));
      await ctx.audit(tx, { action: 'siem.removed', targetType: 'org', targetId: ctx.orgId });
      return { ok: true };
    }),
  ),

  /** Sends one signed test record now and reports what the endpoint answered. */
  testSiem: adminProcedure.mutation(async ({ ctx }) => {
    const [row] = await ctx.inOrg((tx) =>
      tx
        .select({ url: siemDestinations.url, secretEnc: siemDestinations.secretEnc, wrapped: orgs.dataKeyWrapped })
        .from(siemDestinations)
        .innerJoin(orgs, eq(orgs.id, siemDestinations.orgId))
        .where(eq(siemDestinations.orgId, ctx.orgId)),
    );
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'No SIEM endpoint yet' });
    const body = JSON.stringify({ id: 'test', time: new Date().toISOString(), org_id: ctx.orgId, action: 'siem.test', actor_type: 'user', actor_id: ctx.userId }) + '\n';
    const env = new Envelope(ctx.deps.kms, row.wrapped, orgKeyContext(ctx.orgId));
    try {
      const res = await env.useSecret(row.secretEnc, siemSecretAad(ctx.orgId), (secret) =>
        postOutbound(row.url, body, { 'content-type': 'application/x-ndjson', 'x-autodev-signature': signSiemBody(secret, body), 'user-agent': 'AutoDev-SIEM/1' }, {
          allowPrivate: ctx.deps.env.OUTBOUND_ALLOW_PRIVATE === '1',
          timeoutMs: 10_000,
        }),
      );
      return { ok: res.status >= 200 && res.status < 300, status: res.status, body: res.body.slice(0, 300) };
    } catch (e) {
      return { ok: false, status: 0, body: (e as Error).message };
    }
  }),
});
