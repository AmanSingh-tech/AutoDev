import { and, desc, eq, inArray, isNull, schema, sql } from '@autodev/db';
import { z } from 'zod';
import { orgProcedure, router } from '../trpc';

const { notifications } = schema;

export const notificationsRouter = router({
  list: orgProcedure.query(({ ctx }) =>
    ctx.inOrg(async (tx) => {
      const items = await tx
        .select()
        .from(notifications)
        .where(eq(notifications.userId, ctx.userId))
        .orderBy(sql`${notifications.readAt} is not null`, desc(notifications.createdAt))
        .limit(50);
      return { items, unread: items.filter((i) => !i.readAt).length };
    }),
  ),

  markRead: orgProcedure.input(z.object({ ids: z.array(z.string().uuid()).max(100).optional() })).mutation(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      await tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.userId, ctx.userId), isNull(notifications.readAt), input.ids ? inArray(notifications.id, input.ids) : undefined));
      return { ok: true };
    }),
  ),
});
