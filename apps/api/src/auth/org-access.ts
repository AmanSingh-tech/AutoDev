import { isIP } from 'node:net';
import { and, eq, schema, sql, withOrg, type AppDb, type OrgRole } from '@autodev/db';

export type OrgAccess =
  | { ok: true; role: OrgRole; billingManager: boolean }
  | { ok: false; reason: 'not_member' | 'ip_blocked' | 'wrong_region'; message: string };

/**
 * Whether `userId` may act in `orgId` from `ip` on this deployment (B-7): an active member, the
 * org's data region matches DATA_REGION, and the address is on the org's IP allowlist when it has
 * one. Every org-scoped entry point (tRPC, the event stream, billing) goes through this.
 */
export async function checkOrgAccess(app: AppDb, input: { orgId: string; userId: string; ip: string | null; region?: string }): Promise<OrgAccess> {
  const { orgId, userId, ip } = input;
  const [row] = await withOrg(app, orgId, userId, (tx) =>
    tx
      .select({
        role: schema.orgMembers.role,
        billingManager: schema.orgMembers.billingManager,
        region: schema.orgs.dataRegion,
        // Postgres does the CIDR match; an unparsable or missing address never matches a list.
        ipOk: sql<boolean>`cardinality(${schema.orgs.ipAllowlist}) = 0 or coalesce(${validInet(ip)} <<= any(${schema.orgs.ipAllowlist}), false)`,
      })
      .from(schema.orgMembers)
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.orgMembers.orgId))
      .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, userId), eq(schema.orgMembers.status, 'active'))),
  );
  // The message doesn't say whether the org exists.
  if (!row) return { ok: false, reason: 'not_member', message: 'Not a member of this org' };
  if (input.region && row.region !== input.region)
    return { ok: false, reason: 'wrong_region', message: `This organization's data is in the "${row.region}" region; use that region's AutoDev address.` };
  if (!row.ipOk) return { ok: false, reason: 'ip_blocked', message: `Your network address${ip ? ` (${ip})` : ''} isn't on this organization's IP allowlist.` };
  return { ok: true, role: row.role, billingManager: row.billingManager };
}

/** The address as inet, or NULL when it isn't one (so a bad header can't make the query fail). */
const validInet = (raw: string | null) => {
  // IPv4 clients of a dual-stack server show up as ::ffff:a.b.c.d; match them against IPv4 ranges.
  const ip = raw?.startsWith('::ffff:') && isIP(raw.slice(7)) === 4 ? raw.slice(7) : raw;
  return ip && isIP(ip) ? sql`${ip}::inet` : sql`null::inet`;
};
