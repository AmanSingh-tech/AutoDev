import { and, eq, inArray, schema, type SystemDb, type Tx } from '@autodev/db';

const { notifications, orgMembers } = schema;

export interface NotificationInput {
  type: string;
  title: string;
  body?: string;
  link?: string;
  payload?: Record<string, unknown>;
}

/** Notifies every active owner and admin of an org (in-app; email comes later). */
export async function notifyAdmins(db: SystemDb | Tx, orgId: string, n: NotificationInput, extraUserIds: string[] = []) {
  const admins = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.status, 'active'), inArray(orgMembers.role, ['owner', 'admin'])));
  const recipients = [...new Set([...admins.map((a) => a.userId), ...extraUserIds])];
  if (!recipients.length) return;
  await db.insert(notifications).values(
    recipients.map((userId) => ({
      orgId,
      userId,
      type: n.type,
      title: n.title,
      body: n.body ?? null,
      link: n.link ?? null,
      payload: n.payload ?? {},
    })),
  );
}
