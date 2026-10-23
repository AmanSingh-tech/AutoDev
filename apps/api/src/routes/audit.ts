import { auditCsvHeader, auditCsvRow, auditNdjsonRow, readAudit } from '@autodev/governance';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkOrgAccess } from '../auth/org-access';
import { readSession } from '../auth/session';
import type { Deps } from '../deps';
import { audit } from '../services/audit';

const query = z.object({
  org: z.string().uuid(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  format: z.enum(['csv', 'ndjson']).default('csv'),
});

const PAGE = 1000;

/**
 * GET /audit/export?org=…&from=…&to=…&format=csv|ndjson (B-7): the org's audit log as a download,
 * streamed page by page, for owners and admins. The download itself is audited.
 */
export async function auditRoutes(app: FastifyInstance, { deps }: { deps: Deps }) {
  app.get('/audit/export', async (req, reply) => {
    const q = query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'org (uuid) is required; from and to are dates; format is csv or ndjson' });
    const session = await readSession(req.cookies, deps.env.AUTH_SECRET);
    if (!session) return reply.code(401).send({ error: 'Sign in first' });
    const access = await checkOrgAccess(deps.app, { orgId: q.data.org, userId: session.userId, ip: req.ip, region: deps.env.DATA_REGION });
    if (!access.ok) return reply.code(403).send({ error: access.message });
    if (access.role !== 'owner' && access.role !== 'admin') return reply.code(403).send({ error: 'Only owners and admins can export the audit log' });

    await deps.sys.transaction((tx) =>
      audit(tx, {
        orgId: q.data.org,
        actorUserId: session.userId,
        action: 'audit.exported',
        targetType: 'org',
        targetId: q.data.org,
        metadata: { from: q.data.from?.toISOString() ?? null, to: q.data.to?.toISOString() ?? null, format: q.data.format },
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      }),
    );

    const csv = q.data.format === 'csv';
    const stamp = new Date().toISOString().slice(0, 10);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': csv ? 'text/csv; charset=utf-8' : 'application/x-ndjson',
      'content-disposition': `attachment; filename="audit-${stamp}.${csv ? 'csv' : 'ndjson'}"`,
      'cache-control': 'no-store',
    });
    try {
      if (csv) raw.write(auditCsvHeader());
      let after: { createdAt: Date; id: string } | null = null;
      for (;;) {
        const rows = await readAudit(deps.sys, q.data.org, { after, from: q.data.from, to: q.data.to, limit: PAGE });
        for (const r of rows) raw.write(csv ? auditCsvRow(r) : auditNdjsonRow(r));
        if (rows.length < PAGE) break;
        const last = rows[rows.length - 1]!;
        after = { createdAt: last.createdAt, id: last.id };
      }
    } catch (e) {
      req.log.error({ err: e }, 'audit export failed');
    }
    raw.end();
  });
}
