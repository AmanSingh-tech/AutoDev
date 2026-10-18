import { schema, type Tx } from '@autodev/db';

export interface AuditEntry {
  orgId: string;
  actorUserId: string | null;
  actorType?: 'user' | 'agent' | 'system' | 'builder';
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Appends to audit_log in the caller's transaction, so the entry commits with the change it records. */
export async function audit(tx: Pick<Tx, 'insert'>, e: AuditEntry) {
  await tx.insert(schema.auditLog).values({
    orgId: e.orgId,
    actorType: e.actorType ?? 'user',
    actorUserId: e.actorUserId,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    metadata: e.metadata ?? {},
    ip: e.ip ?? null,
    userAgent: e.userAgent ?? null,
  });
}
