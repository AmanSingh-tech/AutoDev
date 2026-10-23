import { createHmac } from 'node:crypto';
import type { KeyWrapper } from '@autodev/crypto';
import { Envelope } from '@autodev/crypto';
import { and, asc, eq, gt, or, orgKeyContext, schema, sql, type SystemDb } from '@autodev/db';
import { postOutbound, type OutboundOptions } from './outbound';

const { auditLog, orgs, siemDestinations, users } = schema;

/** One audit entry as exported (download and SIEM): stable field names, ISO times. */
export interface AuditRecord {
  id: string;
  time: string;
  org_id: string | null;
  action: string;
  actor_type: string;
  actor_id: string | null;
  actor_login: string | null;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
}

export const AUDIT_COLUMNS: (keyof AuditRecord)[] = ['id', 'time', 'org_id', 'action', 'actor_type', 'actor_id', 'actor_login', 'target_type', 'target_id', 'ip', 'user_agent', 'metadata'];

/** The audit log of one org after `cursor` (exclusive), oldest first. */
export async function readAudit(
  sys: SystemDb,
  orgId: string,
  opts: { after?: { createdAt: Date; id: string } | null; from?: Date; to?: Date; limit: number },
): Promise<(AuditRecord & { createdAt: Date })[]> {
  const rows = await sys
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      orgId: auditLog.orgId,
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorId: auditLog.actorUserId,
      actorLogin: users.githubLogin,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      ip: auditLog.ip,
      userAgent: auditLog.userAgent,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(
      and(
        eq(auditLog.orgId, orgId),
        opts.after ? or(gt(auditLog.createdAt, opts.after.createdAt), and(eq(auditLog.createdAt, opts.after.createdAt), gt(auditLog.id, opts.after.id))) : undefined,
        opts.from ? sql`${auditLog.createdAt} >= ${opts.from.toISOString()}` : undefined,
        opts.to ? sql`${auditLog.createdAt} < ${opts.to.toISOString()}` : undefined,
      ),
    )
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
    .limit(opts.limit);
  return rows.map((r) => ({
    createdAt: r.createdAt,
    id: r.id,
    time: r.createdAt.toISOString(),
    org_id: r.orgId,
    action: r.action,
    actor_type: r.actorType,
    actor_id: r.actorId,
    actor_login: r.actorLogin,
    target_type: r.targetType,
    target_id: r.targetId,
    ip: r.ip,
    user_agent: r.userAgent,
    metadata: r.metadata,
  }));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Quote everything that needs it, and defuse spreadsheet formulas.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const auditCsvHeader = () => AUDIT_COLUMNS.join(',') + '\n';
export const auditCsvRow = (r: AuditRecord) => AUDIT_COLUMNS.map((c) => csvCell(r[c])).join(',') + '\n';
export const auditNdjsonRow = (r: AuditRecord) => JSON.stringify(Object.fromEntries(AUDIT_COLUMNS.map((c) => [c, r[c]]))) + '\n';

/** The signature header a SIEM receiver checks: HMAC-SHA256 of `${t}.${body}` with the shared secret. */
export function signSiemBody(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export const siemSecretAad = (orgId: string) => `siem:${orgId}`;

export interface SiemDeps {
  sys: SystemDb;
  kms: KeyWrapper;
  outbound?: OutboundOptions;
}

export interface SiemPushResult {
  orgId: string;
  sent: number;
  error?: string;
}

const BATCH = 500;
const MAX_BATCHES = 20;

/**
 * Sends one org's new audit entries to its SIEM endpoint as signed NDJSON batches, advancing the
 * cursor only after a 2xx. A failure stops the run and is retried next time, from the same place.
 */
export async function pushOrgAudit(deps: SiemDeps, orgId: string): Promise<SiemPushResult> {
  const [dest] = await deps.sys
    .select({ d: siemDestinations, dataKeyWrapped: orgs.dataKeyWrapped })
    .from(siemDestinations)
    .innerJoin(orgs, eq(orgs.id, siemDestinations.orgId))
    .where(eq(siemDestinations.orgId, orgId));
  if (!dest || !dest.d.enabled) return { orgId, sent: 0 };
  const env = new Envelope(deps.kms, dest.dataKeyWrapped, orgKeyContext(orgId));
  let cursor = dest.d.cursorCreatedAt && dest.d.cursorId ? { createdAt: dest.d.cursorCreatedAt, id: dest.d.cursorId } : null;
  let sent = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await readAudit(deps.sys, orgId, { after: cursor, limit: BATCH });
    if (!rows.length) break;
    const body = rows.map(auditNdjsonRow).join('');
    let error: string | null = null;
    try {
      const res = await env.useSecret(dest.d.secretEnc, siemSecretAad(orgId), (secret) =>
        postOutbound(dest.d.url, body, { 'content-type': 'application/x-ndjson', 'x-autodev-signature': signSiemBody(secret, body), 'user-agent': 'AutoDev-SIEM/1' }, deps.outbound),
      );
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}${res.body ? `: ${res.body.slice(0, 200)}` : ''}`;
    } catch (e) {
      error = (e as Error).message;
    }
    if (error) {
      await deps.sys
        .update(siemDestinations)
        .set({ lastError: error, failures: sql`${siemDestinations.failures} + 1`, updatedAt: new Date() })
        .where(eq(siemDestinations.orgId, orgId));
      return { orgId, sent, error };
    }
    const last = rows[rows.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
    sent += rows.length;
    await deps.sys
      .update(siemDestinations)
      .set({ cursorCreatedAt: cursor.createdAt, cursorId: cursor.id, lastSentAt: new Date(), lastError: null, failures: 0, updatedAt: new Date() })
      .where(eq(siemDestinations.orgId, orgId));
    if (rows.length < BATCH) break;
  }
  return { orgId, sent };
}

/** Every enabled destination. */
export async function pushAllAudit(deps: SiemDeps): Promise<SiemPushResult[]> {
  const list = await deps.sys.select({ orgId: siemDestinations.orgId }).from(siemDestinations).where(eq(siemDestinations.enabled, true));
  const out: SiemPushResult[] = [];
  for (const d of list) out.push(await pushOrgAudit(deps, d.orgId));
  return out;
}
